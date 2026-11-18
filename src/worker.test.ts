// src/worker.ts を mock host で動かす。Asana API と orca CLI は deps を差し替えて偽装する。
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

type Call = { url: string; method: string; body: unknown }

function fakeAsana(routes: Record<string, unknown>, calls: Call[]) {
  main.deps.fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    const path = url.replace('https://app.asana.com/api/1.0', '')
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k))
    if (!key) return new Response(JSON.stringify({ errors: [{ message: 'not found' }] }), { status: 404 })
    return new Response(JSON.stringify(routes[key]), { status: 200 })
  }
}

test('トークン未設定ならその旨を返す', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  assert.deepEqual(await worker.request('asana.status'), { hasToken: false, me: null, error: null })
  await worker.deactivate()
})

test('トークンを検証して保存する', async () => {
  const calls: Call[] = []
  fakeAsana({ 'GET /users/me': { data: { name: '山田' } } }, calls)
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('asana.setToken', { token: ' abc ' }), { me: '山田' })
  assert.deepEqual(host.data().secrets, { asanaToken: 'abc' })
  await worker.deactivate()
})

test('タスクを期限順に並べ、消えたワークスペースのリンクを捨てる', async () => {
  const calls: Call[] = []
  fakeAsana(
    {
      'GET /users/me': { data: { workspaces: [{ gid: '1' }] } },
      'GET /tasks?': {
        data: [
          { gid: '20', name: '期限なし', due_on: null, permalink_url: 'u20', projects: [] },
          { gid: '10', name: '早い', due_on: '2026-11-15', permalink_url: 'u10', projects: [{ name: 'P' }] },
          { gid: '30', name: '', due_on: null }
        ],
        next_page: null
      }
    },
    calls
  )
  const host = mockHost({
    secrets: { asanaToken: 't' },
    storage: {
      links: {
        '10': { workspaceId: 'w1', path: '/ws/a', name: 'a' },
        '99': { workspaceId: 'w9', path: '/ws/gone', name: 'gone' }
      }
    },
    results: {
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'a', path: '/ws/a', branch: 'b', hostId: 'local' }],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })
  const { tasks } = await worker.request('asana.tasks')
  assert.deepEqual(
    tasks.map((t) => [t.gid, t.dueOn, t.workspace?.path ?? null]),
    [
      ['10', '2026-11-15', '/ws/a'],
      ['20', null, null]
    ]
  )
  assert.deepEqual(Object.keys(host.data().storage.links as object), ['10'])
  assert.equal(calls[1].url.includes('assignee=me'), true)
  await worker.deactivate()
})

test('この Mac と各 Orca サーバーのリポジトリを集め、繋がらないサーバーを報告する', async () => {
  main.deps.runOrca = async (args) => {
    if (args[0] === 'environment') {
      return JSON.stringify({
        ok: true,
        result: { environments: [{ id: 'env-m', name: 'server-a' }, { id: 'env-h', name: 'server-b' }] }
      })
    }
    const env = args.includes('--environment') ? args[args.indexOf('--environment') + 1] : 'local'
    if (env === 'env-h') throw new Error('接続できません')
    const names = env === 'local' ? ['orca-asana-tasks'] : ['repo-b', 'repo-a']
    return JSON.stringify({
      ok: true,
      result: { repos: names.map((n) => ({ id: `${env}-${n}`, displayName: n })) }
    })
  }
  const worker = await mountWorker(main, { host: mockHost() })
  const { repos, unreachable } = await worker.request('orca.repos')
  assert.deepEqual(
    repos.map((r) => [r.key, r.name, r.hostName]),
    [
      ['local::local-orca-asana-tasks', 'orca-asana-tasks', 'この Mac'],
      ['env-m::env-m-repo-a', 'repo-a', 'server-a'],
      ['env-m::env-m-repo-b', 'repo-b', 'server-a']
    ]
  )
  assert.deepEqual(unreachable, ['server-b'])
  await worker.deactivate()
})

test('リモートの Orca サーバーに着手すると --environment 付きで作り、リンクにサーバーを残す', async () => {
  fakeAsana(
    { 'GET /tasks/77': { data: { gid: '77', name: 'PBX の設定', notes: '', permalink_url: 'https://app.asana.com/y' } } },
    []
  )
  const cli: string[][] = []
  main.deps.runOrca = async (args) => {
    cli.push(args)
    if (args[0] === 'environment') {
      return JSON.stringify({ ok: true, result: { environments: [{ id: 'env-m', name: 'server-a' }] } })
    }
    if (args[1] === 'create') return JSON.stringify({ ok: true, result: { worktree: { path: '/remote/ws' } } })
    if (args[1] === 'list') return JSON.stringify({ ok: true, result: { worktrees: [] } })
    return JSON.stringify({ ok: true, result: {} })
  }
  const host = mockHost({
    secrets: { asanaToken: 't' },
    results: { 'workspace.list': { workspaces: [], truncated: false } }
  })
  const worker = await mountWorker(main, { host })
  const link = await worker.request('task.start', { gid: '77', repoKey: 'env-m::repo-9' })
  assert.deepEqual(link, {
    workspaceId: null,
    path: '/remote/ws',
    name: 'PBX の設定',
    environment: 'env-m',
    hostName: 'server-a'
  })
  const create = cli.find((a) => a[1] === 'create')!
  assert.deepEqual(create.slice(0, 4), ['worktree', 'create', '--repo', 'id:repo-9'])
  assert.deepEqual(create.slice(-2), ['--environment', 'env-m'])
  const rename = cli.find((a) => a[1] === 'set')!
  assert.deepEqual(rename, [
    'worktree', 'set', '--worktree', 'path:/remote/ws', '--display-name', 'PBX の設定', '--json', '--environment', 'env-m'
  ])

  // 開くときは host API で見つからないので CLI の activate に回す
  assert.deepEqual(await worker.request('task.open', { gid: '77' }), { opened: true })
  assert.deepEqual(cli.at(-1), ['worktree', 'activate', '--worktree', 'path:/remote/ws', '--json', '--environment', 'env-m'])
  await worker.deactivate()
})

test('リモートのリンクは、そのサーバーに無ければ捨て、繋がらなければ残す', async () => {
  fakeAsana(
    {
      'GET /users/me': { data: { workspaces: [{ gid: '1' }] } },
      'GET /tasks?': { data: [], next_page: null }
    },
    []
  )
  main.deps.runOrca = async (args) => {
    const env = args[args.indexOf('--environment') + 1]
    if (env === 'env-h') throw new Error('接続できません')
    return JSON.stringify({ ok: true, result: { worktrees: [{ path: '/m/alive' }] } })
  }
  const host = mockHost({
    secrets: { asanaToken: 't' },
    storage: {
      links: {
        '1': { workspaceId: null, path: '/m/alive', name: 'a', environment: 'env-m' },
        '2': { workspaceId: null, path: '/m/gone', name: 'b', environment: 'env-m' },
        '3': { workspaceId: null, path: '/h/x', name: 'c', environment: 'env-h' }
      }
    },
    results: { 'workspace.list': { workspaces: [], truncated: false } }
  })
  const worker = await mountWorker(main, { host })
  await worker.request('asana.tasks')
  assert.deepEqual(Object.keys(host.data().storage.links as object).sort(), ['1', '3'])
  await worker.deactivate()
})

test('着手するとワークスペースを作り、名前をタスク名にしてリンクを残す', async () => {
  const calls: Call[] = []
  fakeAsana(
    {
      'GET /tasks/123': {
        data: { gid: '123', name: '請求書の確認', notes: '詳細', due_on: null, permalink_url: 'https://app.asana.com/x' }
      }
    },
    calls
  )
  const cli: string[][] = []
  main.deps.runOrca = async (args) => {
    cli.push(args)
    return JSON.stringify({ ok: true, result: { worktree: { path: '/ws/new' } } })
  }
  const host = mockHost({
    secrets: { asanaToken: 't' },
    results: {
      'workspace.list': {
        workspaces: [{ id: 'w-new', kind: 'worktree', name: 'asana-123', path: '/ws/new', branch: 'x', hostId: 'local' }],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })
  // 区切りの無い古い値は この Mac のリポジトリとして扱う
  const link = await worker.request('task.start', { gid: '123', repoKey: 'repo-1' })
  assert.deepEqual(link, { workspaceId: 'w-new', path: '/ws/new', name: '請求書の確認' })
  const args = cli[0]
  assert.deepEqual(args.slice(0, 4), ['worktree', 'create', '--repo', 'id:repo-1'])
  assert.equal(args.includes('--environment'), false)
  assert.equal(args[args.indexOf('--agent') + 1], 'claude')
  assert.equal(args[args.indexOf('--prompt') + 1].includes('https://app.asana.com/x'), true)
  assert.deepEqual(cli[1], ['worktree', 'set', '--worktree', 'path:/ws/new', '--display-name', '請求書の確認', '--json'])
  await assert.rejects(worker.request('task.start', { gid: '123', repoKey: 'local::repo-1' }))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('完了にすると Asana に completed: true を送る', async () => {
  const calls: Call[] = []
  fakeAsana({ 'PUT /tasks/55': { data: { gid: '55', completed: true } } }, calls)
  const worker = await mountWorker(main, { host: mockHost({ secrets: { asanaToken: 't' } }) })
  assert.deepEqual(await worker.request('task.complete', { gid: '55' }), { ok: true })
  assert.deepEqual(calls[0].body, { data: { completed: true } })
  await worker.deactivate()
})
