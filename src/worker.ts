// Asana Tasks のワーカー。Asana API を呼び、ワークスペース作成は orca CLI に任せる
// （このバージョンの Orca には、プラグインからワークスペースを作る host API がまだないため）。
import type { OrcaWorkerApi } from 'orca/worker'
import type { AsanaTask, AsanaTaskWorkspace, OrcaRepo } from 'orca'
import { execFile } from 'node:child_process'

const ASANA = 'https://app.asana.com/api/1.0'
const TOKEN_KEY = 'asanaToken'
const LINKS_KEY = 'links'
const ORCA_BIN =
  process.env.ORCA_CLI_COMMAND || '/Applications/Orca.app/Contents/Resources/bin/orca'

type Links = Record<string, AsanaTaskWorkspace>
type RawTask = {
  gid: string
  name: string
  notes?: string
  due_on?: string | null
  permalink_url?: string
  projects?: { name?: string }[]
}

/** テストで差し替えられるように外に出している */
export const deps = {
  fetch: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
  runOrca: (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        ORCA_BIN,
        args,
        { timeout: 110_000, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`orca ${args.slice(0, 2).join(' ')} に失敗: ${stderr || stdout || error.message}`))
            return
          }
          resolve(stdout)
        }
      )
    })
}

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

async function token(orca: OrcaWorkerApi): Promise<string> {
  const value = await orca.secrets.get(TOKEN_KEY)
  if (!value) throw fail('invalid_params', 'Asana のトークンが未設定です')
  return value
}

async function asana<T>(
  tok: string,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const res = await deps.fetch(`${ASANA}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: init?.body ? JSON.stringify({ data: init.body }) : undefined
  })
  const text = await res.text()
  if (!res.ok) {
    let detail = text.slice(0, 200)
    try {
      detail = JSON.parse(text).errors?.[0]?.message ?? detail
    } catch {
      // JSON でない応答はそのまま出す
    }
    throw fail(res.status === 401 ? 'invalid_params' : 'action_failed', `Asana API ${res.status}: ${detail}`)
  }
  return JSON.parse(text) as T
}

async function readLinks(orca: OrcaWorkerApi): Promise<Links> {
  const value = await orca.storage.get(LINKS_KEY)
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Links) : {}
}

/** CLI の JSON 出力から、最初に見つかった key の文字列値を探す */
function findString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, key)
      if (found) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record[key] === 'string') return record[key] as string
  for (const child of Object.values(record)) {
    const found = findString(child, key)
    if (found) return found
  }
  return null
}

function buildPrompt(task: RawTask): string {
  const notes = (task.notes ?? '').trim()
  const lines = [
    `Asana のタスク「${task.name}」に取り組んでください。`,
    `URL: ${task.permalink_url ?? ''}`,
    task.due_on ? `期限: ${task.due_on}` : '',
    '',
    '## タスクの説明',
    notes ? (notes.length > 4000 ? `${notes.slice(0, 4000)}\n（以下省略。全文は URL を参照）` : notes) : '（説明なし）',
    '',
    '## 進め方',
    '- 着手前に Goal / Constraints / Acceptance Criteria を整理し、曖昧な点があれば確認してください。',
    `- 作業が一段落したら、対応内容を Asana タスク（gid: ${task.gid}）にコメントで残してください。`
  ]
  return lines.filter((line, i) => line !== '' || lines[i - 1] !== '').join('\n')
}

const LOCAL = 'local'
type Environment = { id: string; name: string }

/** CLI の対象 Orca を指定する引数。local（この Mac）なら何も付けない */
function envArgs(environment: string | undefined): string[] {
  return !environment || environment === LOCAL ? [] : ['--environment', environment]
}

/** この Mac と、ペアリング済みの Orca サーバー */
async function listEnvironments(orca: OrcaWorkerApi): Promise<Environment[]> {
  const targets: Environment[] = [{ id: LOCAL, name: 'この Mac' }]
  try {
    const out = JSON.parse(await deps.runOrca(['environment', 'list', '--json']))
    const list: { id?: string; name?: string }[] = out?.result?.environments ?? []
    for (const e of list) if (e.id) targets.push({ id: e.id, name: e.name || e.id })
  } catch (error) {
    orca.log(`environment list に失敗: ${String(error)}`)
  }
  return targets
}

/** OrcaRepo.key を Orca の id とリポジトリ id に分ける。区切りが無い古い値は local 扱い */
function parseRepoKey(key: string): { environment: string; repoId: string } {
  const at = key.indexOf('::')
  return at < 0
    ? { environment: LOCAL, repoId: key }
    : { environment: key.slice(0, at), repoId: key.slice(at + 2) }
}

async function findWorkspaceId(
  orca: OrcaWorkerApi,
  path: string,
  environment: string | undefined
): Promise<string | null> {
  try {
    const { workspaces } = await orca.host.call('workspace.list')
    const remote = environment && environment !== LOCAL ? `runtime:${environment}` : null
    const matches = workspaces.filter((w) => w.path === path)
    return (remote ? matches.find((w) => w.hostId === remote) : null)?.id ?? matches[0]?.id ?? null
  } catch (error) {
    orca.log(`workspace.list に失敗: ${String(error)}`)
    return null
  }
}

/** リモートのリンクのうち、その Orca サーバーにもう無いワークスペースを捨てる（繋がらないサーバーのリンクは残す） */
async function pruneRemoteLinks(orca: OrcaWorkerApi, links: Links): Promise<boolean> {
  const envs = new Set(
    Object.values(links)
      .map((l) => l.environment)
      .filter((e): e is string => !!e && e !== LOCAL)
  )
  let changed = false
  for (const env of envs) {
    let paths: Set<string>
    try {
      const out = JSON.parse(await deps.runOrca(['worktree', 'list', '--json', ...envArgs(env)]))
      const list: { path?: string }[] = out?.result?.worktrees ?? []
      paths = new Set(list.map((w) => w.path ?? ''))
    } catch (error) {
      orca.log(`worktree list（${env}）に失敗: ${String(error)}`)
      continue
    }
    for (const [gid, link] of Object.entries(links)) {
      if (link.environment === env && !paths.has(link.path)) {
        delete links[gid]
        changed = true
      }
    }
  }
  return changed
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('asana.status', async () => {
    const tok = await orca.secrets.get(TOKEN_KEY)
    if (!tok) return { hasToken: false, me: null, error: null }
    try {
      const me = await asana<{ data: { name: string } }>(tok, '/users/me?opt_fields=name')
      return { hasToken: true, me: me.data.name, error: null }
    } catch (error) {
      return { hasToken: true, me: null, error: (error as Error).message }
    }
  })

  orca.panels.handle('asana.setToken', async ({ token: raw }) => {
    const tok = raw.trim()
    if (!tok) throw fail('invalid_params', 'トークンが空です')
    const me = await asana<{ data: { name: string } }>(tok, '/users/me?opt_fields=name')
    await orca.secrets.set(TOKEN_KEY, tok)
    orca.panels.post('tasks.changed', { reason: 'token' })
    return { me: me.data.name }
  })

  orca.panels.handle('asana.clearToken', async () => {
    await orca.secrets.delete(TOKEN_KEY)
    orca.panels.post('tasks.changed', { reason: 'token' })
    return { ok: true as const }
  })

  orca.panels.handle('asana.tasks', async () => {
    const tok = await token(orca)
    const me = await asana<{ data: { workspaces: { gid: string }[] } }>(
      tok,
      '/users/me?opt_fields=workspaces'
    )
    const raw: RawTask[] = []
    for (const ws of me.data.workspaces) {
      let offset: string | null = null
      do {
        const query = new URLSearchParams({
          assignee: 'me',
          workspace: ws.gid,
          completed_since: 'now',
          limit: '100',
          opt_fields: 'name,due_on,permalink_url,projects.name'
        })
        if (offset) query.set('offset', offset)
        const page: { data: RawTask[]; next_page: { offset: string } | null } = await asana(
          tok,
          `/tasks?${query}`
        )
        raw.push(...page.data)
        offset = page.next_page?.offset ?? null
      } while (offset && raw.length < 1000)
    }

    // 消えたワークスペースへのリンクは捨てる（この Mac は host API、リモートは CLI で確かめる）
    const links = await readLinks(orca)
    let changed = false
    try {
      const { workspaces } = await orca.host.call('workspace.list')
      const live = new Set(workspaces.map((w) => w.path))
      for (const [gid, link] of Object.entries(links)) {
        if ((!link.environment || link.environment === LOCAL) && !live.has(link.path)) {
          delete links[gid]
          changed = true
        }
      }
    } catch (error) {
      orca.log(`workspace.list に失敗: ${String(error)}`)
    }
    if (await pruneRemoteLinks(orca, links)) changed = true
    if (changed) await orca.storage.set(LINKS_KEY, links)

    const tasks: AsanaTask[] = raw
      .filter((t) => t.name.trim() !== '')
      .map((t) => ({
        gid: t.gid,
        name: t.name,
        dueOn: t.due_on ?? null,
        url: t.permalink_url ?? `https://app.asana.com/0/0/${t.gid}`,
        projects: (t.projects ?? []).map((p) => p.name ?? '').filter(Boolean),
        workspace: links[t.gid] ?? null
      }))
      .sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'))
    return { tasks }
  })

  orca.panels.handle('orca.repos', async () => {
    const targets = await listEnvironments(orca)
    const results = await Promise.allSettled(
      targets.map(async (env) => {
        const out = JSON.parse(await deps.runOrca(['repo', 'list', '--json', ...envArgs(env.id)]))
        const list: { id: string; displayName?: string; path?: string }[] =
          out?.result?.repos ?? out?.result ?? []
        return list.map(
          (r): OrcaRepo => ({
            key: `${env.id}::${r.id}`,
            id: r.id,
            name: r.displayName || r.path || r.id,
            environment: env.id,
            hostName: env.name
          })
        )
      })
    )
    const repos: OrcaRepo[] = []
    const unreachable: string[] = []
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') repos.push(...result.value)
      else {
        unreachable.push(targets[i].name)
        orca.log(`repo list（${targets[i].name}）に失敗: ${String(result.reason)}`)
      }
    })
    // この Mac を先頭に、Orca ごとにまとめて名前順
    const order = new Map(targets.map((t, i) => [t.id, i]))
    repos.sort(
      (a, b) =>
        (order.get(a.environment) ?? 0) - (order.get(b.environment) ?? 0) || a.name.localeCompare(b.name)
    )
    return { repos, unreachable }
  })

  orca.panels.handle('task.start', async ({ gid, repoKey }) => {
    if (!/^\d+$/.test(gid)) throw fail('invalid_params', `不正なタスク gid: ${gid}`)
    if (!repoKey) throw fail('invalid_params', 'リポジトリを選んでください')
    const { environment, repoId } = parseRepoKey(repoKey)
    const links = await readLinks(orca)
    if (links[gid]) throw fail('conflict', 'このタスクのワークスペースはもうあります')

    const tok = await token(orca)
    const { data: task } = await asana<{ data: RawTask }>(
      tok,
      `/tasks/${gid}?opt_fields=name,notes,due_on,permalink_url`
    )
    const out = JSON.parse(
      await deps.runOrca([
        'worktree',
        'create',
        '--repo',
        `id:${repoId}`,
        '--name',
        `asana-${gid}`,
        '--agent',
        'claude',
        '--prompt',
        buildPrompt(task),
        '--comment',
        `Asana: ${task.permalink_url ?? gid}`,
        '--no-parent',
        '--activate',
        '--json',
        ...envArgs(environment)
      ])
    )
    const path = findString(out?.result, 'path')
    if (!path) throw fail('action_failed', 'ワークスペースは作られましたが、パスを読み取れませんでした')

    // 名前はタスク名にする。リモートの Orca にも効くよう CLI で変える
    const name = task.name.length > 60 ? `${task.name.slice(0, 59)}…` : task.name
    try {
      await deps.runOrca([
        'worktree',
        'set',
        '--worktree',
        `path:${path}`,
        '--display-name',
        name,
        '--json',
        ...envArgs(environment)
      ])
    } catch (error) {
      orca.log(`worktree set（名前変更）に失敗: ${String(error)}`)
    }
    const workspaceId = await findWorkspaceId(orca, path, environment)
    const hostName =
      environment === LOCAL
        ? undefined
        : (await listEnvironments(orca)).find((e) => e.id === environment)?.name ?? environment
    const link: AsanaTaskWorkspace = {
      workspaceId,
      path,
      name,
      ...(environment === LOCAL ? {} : { environment, hostName })
    }
    await orca.storage.set(LINKS_KEY, { ...links, [gid]: link })
    orca.panels.post('tasks.changed', { reason: 'start' })
    return link
  })

  orca.panels.handle('task.open', async ({ gid }) => {
    const link = (await readLinks(orca))[gid]
    if (!link) throw fail('invalid_params', 'このタスクのワークスペースはありません')
    const remote = !!link.environment && link.environment !== LOCAL
    const workspaceId = link.workspaceId ?? (await findWorkspaceId(orca, link.path, link.environment))
    if (workspaceId) {
      try {
        await orca.host.call('workspace.open', { workspaceId })
        return { opened: true }
      } catch (error) {
        if (!remote) throw error
        orca.log(`workspace.open に失敗、CLI で開き直す: ${String(error)}`)
      }
    }
    if (!remote) throw fail('action_failed', 'ワークスペースが見つかりません')
    await deps.runOrca([
      'worktree',
      'activate',
      '--worktree',
      `path:${link.path}`,
      '--json',
      ...envArgs(link.environment)
    ])
    return { opened: true }
  })

  orca.panels.handle('task.complete', async ({ gid }) => {
    if (!/^\d+$/.test(gid)) throw fail('invalid_params', `不正なタスク gid: ${gid}`)
    const tok = await token(orca)
    await asana(tok, `/tasks/${gid}`, { method: 'PUT', body: { completed: true } })
    orca.panels.post('tasks.changed', { reason: 'complete' })
    return { ok: true as const }
  })
}
