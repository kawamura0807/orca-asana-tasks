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
      'orca.repos': { repos: [{ id: 'r1', name: 'repo-c' }] },
      'task.start': (input) => {
        started.push(input)
        return { workspaceId: 'w', path: '/p', name: task.name }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Asana: 山田' }))
  await view.select({ label: 'ワークスペースを作るリポジトリ' }, 'r1')
  await view.selectRows({ label: '自分のタスク' }, ['10'])
  await view.press({ text: '着手（ワークスペース作成＋Claude）' })
  assert.deepEqual(started, [{ gid: '10', repoId: 'r1' }])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
