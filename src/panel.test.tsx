// パネルを mock host で描く。ワーカーの応答は requests で偽装する。
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

const task = {
  gid: '10',
  name: '請求書の確認',
  dueOn: '2026-11-15',
  url: 'https://app.asana.com/x',
  projects: ['経理'],
  workspace: null
}

test('トークン未設定ならトークン入力欄を出す', async () => {
  const host = mockHost({
    requests: { 'asana.status': { hasToken: false, me: null, error: null } }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: '保存' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('タスクを選んで着手するとワークスペース作成を頼む', async () => {
  const started: unknown[] = []
  const host = mockHost({
    storage: {},
    requests: {
      'asana.status': { hasToken: true, me: '山田', error: null },
      'asana.tasks': { tasks: [task] },
      'orca.repos': {
        repos: [
          { key: 'local::r0', id: 'r0', name: 'orca-asana-tasks', environment: 'local', hostName: 'この Mac' },
          { key: 'env-m::r1', id: 'r1', name: 'repo-c', environment: 'env-m', hostName: 'server-a' }
        ],
        unreachable: ['server-b']
      },
      'task.start': (input) => {
        started.push(input)
        return { workspaceId: 'w', path: '/p', name: task.name }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Asana: 山田' }))
  assert.ok(view.find({ text: '繋がらなかった Orca: server-b（そのリポジトリは一覧に出ていません）' }))
  await view.select({ label: 'ワークスペースを作るリポジトリ' }, 'env-m::r1')
  await view.selectRows({ label: '自分のタスク' }, ['10'])
  await view.press({ text: '着手（ワークスペース作成＋Claude）' })
  assert.deepEqual(started, [{ gid: '10', repoKey: 'env-m::r1' }])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
