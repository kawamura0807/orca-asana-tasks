// パネル <-> ワーカーの契約。src/panel.tsx と src/worker.ts の両方がこれを読む。
export {}

declare module 'orca' {
  /** このタスクから作った Orca ワークスペース */
  type AsanaTaskWorkspace = { workspaceId: string | null; path: string; name: string }
  /** パネルに出す Asana タスク1件 */
  type AsanaTask = {
    gid: string
    name: string
    dueOn: string | null
    url: string
    projects: string[]
    workspace: AsanaTaskWorkspace | null
  }
  type OrcaRepo = { id: string; name: string }

  interface PluginRequests {
    /** トークンが保存済みか、と Asana 上の自分の名前 */
    'asana.status': { output: { hasToken: boolean; me: string | null; error: string | null } }
    /** トークンを検証して保存する */
    'asana.setToken': { input: { token: string }; output: { me: string } }
    'asana.clearToken': { output: { ok: true } }
    /** 自分に割り当てられた未完了タスク（期限順） */
    'asana.tasks': { output: { tasks: AsanaTask[] } }
    /** Orca に登録されているリポジトリ */
    'orca.repos': { output: { repos: OrcaRepo[] } }
    /** タスクからワークスペースを作り、Claude を起動する */
    'task.start': { input: { gid: string; repoId: string }; output: AsanaTaskWorkspace }
    /** タスクのワークスペースを Orca で開く */
    'task.open': { input: { gid: string }; output: { opened: boolean } }
    /** Asana でタスクを完了にする */
    'task.complete': { input: { gid: string }; output: { ok: true } }
  }
  interface PluginPanelEvents {
    /** タスク一覧かリンクが変わった */
    'tasks.changed': { reason: string }
  }
}
