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
      },
      'workspace.rename': ({ name }: { name: string }) => ({ name })
    }
  })
  const worker = await mountWorker(main, { host })
  const link = await worker.request('task.start', { gid: '123', repoId: 'repo-1' })
  assert.deepEqual(link, { workspaceId: 'w-new', path: '/ws/new', name: '請求書の確認' })
  const args = cli[0]
  assert.deepEqual(args.slice(0, 4), ['worktree', 'create', '--repo', 'id:repo-1'])
  assert.equal(args[args.indexOf('--agent') + 1], 'claude')
  assert.equal(args[args.indexOf('--prompt') + 1].includes('https://app.asana.com/x'), true)
  assert.deepEqual(host.callsOf('workspace.rename'), [{ workspaceId: 'w-new', name: '請求書の確認' }])
  await assert.rejects(worker.request('task.start', { gid: '123', repoId: 'repo-1' }))
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
