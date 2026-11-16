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

async function findWorkspaceId(orca: OrcaWorkerApi, path: string): Promise<string | null> {
  try {
    const { workspaces } = await orca.host.call('workspace.list')
    return workspaces.find((w) => w.path === path)?.id ?? null
  } catch (error) {
    orca.log(`workspace.list に失敗: ${String(error)}`)
    return null
  }
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

    // 消えたワークスペースへのリンクは捨てる
    const links = await readLinks(orca)
    let live: Set<string> | null = null
    try {
      const { workspaces } = await orca.host.call('workspace.list')
      live = new Set(workspaces.map((w) => w.path))
    } catch (error) {
      orca.log(`workspace.list に失敗: ${String(error)}`)
    }
    if (live) {
      let changed = false
      for (const [gid, link] of Object.entries(links)) {
        if (!live.has(link.path)) {
          delete links[gid]
          changed = true
        }
      }
      if (changed) await orca.storage.set(LINKS_KEY, links)
    }

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
    const out = JSON.parse(await deps.runOrca(['repo', 'list', '--json']))
    const list: { id: string; displayName?: string; path?: string }[] =
      out?.result?.repos ?? out?.result ?? []
    const repos: OrcaRepo[] = list
      .map((r) => ({ id: r.id, name: r.displayName || r.path || r.id }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { repos }
  })

  orca.panels.handle('task.start', async ({ gid, repoId }) => {
    if (!/^\d+$/.test(gid)) throw fail('invalid_params', `不正なタスク gid: ${gid}`)
    if (!repoId) throw fail('invalid_params', 'リポジトリを選んでください')
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
        '--json'
      ])
    )
    const path = findString(out?.result, 'path')
    if (!path) throw fail('action_failed', 'ワークスペースは作られましたが、パスを読み取れませんでした')

    const workspaceId = await findWorkspaceId(orca, path)
    const name = task.name.length > 60 ? `${task.name.slice(0, 59)}…` : task.name
    if (workspaceId) {
      try {
        await orca.host.call('workspace.rename', { workspaceId, name })
      } catch (error) {
        orca.log(`workspace.rename に失敗: ${String(error)}`)
      }
    }
    const link: AsanaTaskWorkspace = { workspaceId, path, name }
    await orca.storage.set(LINKS_KEY, { ...links, [gid]: link })
    orca.panels.post('tasks.changed', { reason: 'start' })
    return link
  })

  orca.panels.handle('task.open', async ({ gid }) => {
    const link = (await readLinks(orca))[gid]
    if (!link) throw fail('invalid_params', 'このタスクのワークスペースはありません')
    const workspaceId = link.workspaceId ?? (await findWorkspaceId(orca, link.path))
    if (!workspaceId) throw fail('action_failed', 'ワークスペースが見つかりません')
    await orca.host.call('workspace.open', { workspaceId })
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
