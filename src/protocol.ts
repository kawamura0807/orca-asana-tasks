// パネル <-> ワーカーの契約。src/panel.tsx と src/worker.ts の両方がこれを読む。
export {}

declare module 'orca' {
  /**
   * このタスクから作った Orca ワークスペース。
   * environment は作った先の Orca（'local' かペアリング済み Orca サーバーの id）。古いリンクには無い＝local。
   */
  type AsanaTaskWorkspace = {
    workspaceId: string | null
    path: string
    name: string
    environment?: string
    hostName?: string
  }
  /** パネルに出す Asana タスク1件 */
  type AsanaTask = {
    gid: string
    name: string
    dueOn: string | null
    url: string
    projects: string[]
    workspace: AsanaTaskWorkspace | null
  }
  /** ワークスペースを作れるリポジトリ。key は `${environment}::${id}` */
  type OrcaRepo = { key: string; id: string; name: string; environment: string; hostName: string }

  interface PluginRequests {
    /** トークンが保存済みか、と Asana 上の自分の名前 */
    'asana.status': { output: { hasToken: boolean; me: string | null; error: string | null } }
    /** トークンを検証して保存する */
    'asana.setToken': { input: { token: string }; output: { me: string } }
    'asana.clearToken': { output: { ok: true } }
    /** 自分に割り当てられた未完了タスク（期限順） */
    'asana.tasks': { output: { tasks: AsanaTask[] } }
    /** この Mac とペアリング済み Orca サーバーに登録されているリポジトリ。unreachable は繋がらなかったサーバー名 */
    'orca.repos': { output: { repos: OrcaRepo[]; unreachable: string[] } }
    /** タスクからワークスペースを作り、Claude を起動する（repoKey は OrcaRepo.key） */
    'task.start': { input: { gid: string; repoKey: string }; output: AsanaTaskWorkspace }
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
