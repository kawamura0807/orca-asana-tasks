// Asana Tasks パネル。ビルド不要（Orca が読み込み時に型を外して JSX を変換する）。
import {
  atom,
  Button,
  Callout,
  Card,
  IconButton,
  Input,
  Link,
  plugin,
  read,
  Row,
  Select,
  set,
  shell,
  Skeleton,
  Spinner,
  Stack,
  Table,
  Text,
  type AsanaTask,
  type OrcaRepo,
  type PanelContext
} from 'orca'

type Status = { hasToken: boolean; me: string | null; error: string | null }

const status = atom<Status | null>(null)
const tasks = atom<AsanaTask[] | null>(null)
const repos = atom<OrcaRepo[]>([])
const selected = atom<string | null>(null)
const busy = atom<string | null>(null)
const error = atom<string | null>(null)
const confirmComplete = atom(false)
const tokenDraft = atom('')
/** 前回選んだリポジトリを覚えておく */
const repoId = atom('repoId', '', { persist: 'plugin' })

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  set(busy, label)
  set(error, null)
  try {
    await fn()
  } catch (e) {
    set(error, message(e))
  } finally {
    set(busy, null)
  }
}

async function loadTasks(): Promise<void> {
  const answer = await plugin.request('asana.tasks', undefined, { timeoutMs: 60_000 })
  set(tasks, answer.tasks)
  const current = read(selected)
  if (current && !answer.tasks.some((t) => t.gid === current)) set(selected, null)
}

async function loadAll(): Promise<void> {
  const s = await plugin.request('asana.status')
  set(status, s)
  if (!s.hasToken || s.error) return
  await Promise.all([
    loadTasks(),
    plugin.request('orca.repos', undefined, { timeoutMs: 30_000 }).then((r) => set(repos, r.repos))
  ])
}

function refresh(): Promise<void> {
  return run('読み込み中', loadAll)
}

function saveToken(): Promise<void> {
  return run('トークンを確認中', async () => {
    await plugin.request('asana.setToken', { token: read(tokenDraft) })
    set(tokenDraft, '')
    await loadAll()
  })
}

function clearToken(): Promise<void> {
  return run('トークンを削除中', async () => {
    await plugin.request('asana.clearToken')
    set(tasks, null)
    set(selected, null)
    await loadAll()
  })
}

function startTask(task: AsanaTask): Promise<void> {
  return run('ワークスペースを作成中', async () => {
    await plugin.request('task.start', { gid: task.gid, repoId: read(repoId) }, { timeoutMs: 120_000 })
    await loadTasks()
  })
}

function openTask(task: AsanaTask): Promise<void> {
  return run('開いています', () => plugin.request('task.open', { gid: task.gid }))
}

function completeTask(task: AsanaTask): Promise<void> {
  return run('完了にしています', async () => {
    await plugin.request('task.complete', { gid: task.gid })
    set(confirmComplete, false)
    await loadTasks()
  })
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('tasks.changed', () => {
      void run('読み込み中', loadAll)
    })
  )
  void refresh()
}

function TokenForm() {
  return (
    <Stack gap="sm">
      <Callout tone="accent" title="Asana の個人アクセストークンを登録してください">
        Asana の開発者コンソールで発行したトークンを入れると、自分に割り当てられたタスクがここに並びます。トークンは
        Orca の暗号化された保存領域（OS のキーチェーン）に入ります。
      </Callout>
      <Link onPress={() => shell.openExternal('https://app.asana.com/0/my-apps')}>
        開発者コンソールを開く
      </Link>
      <Input
        label="個人アクセストークン"
        type="password"
        value={read(tokenDraft)}
        onChange={(v) => set(tokenDraft, v)}
        onSubmit={() => void saveToken()}
      />
      <Button tone="accent" disabled={read(tokenDraft).trim() === ''} onPress={saveToken}>
        保存
      </Button>
    </Stack>
  )
}

function TaskActions({ task }: { task: AsanaTask }) {
  const repoChosen = read(repoId) !== ''
  const meta = [task.dueOn ? `期限 ${task.dueOn}` : '期限なし', ...task.projects].join(' ・ ')
  return (
    <Card title={task.name} description={meta}>
      <Stack gap="sm">
        {task.workspace ? (
          <Row gap="xs" wrap>
            <Button tone="accent" icon="folder" onPress={() => openTask(task)}>
              ワークスペースを開く
            </Button>
            <Text muted size="xs" truncate>
              {task.workspace.name}
            </Text>
          </Row>
        ) : (
          <Button
            tone="accent"
            icon="agent"
            disabled={!repoChosen}
            tooltip={repoChosen ? undefined : '先にリポジトリを選んでください'}
            onPress={() => startTask(task)}
          >
            着手（ワークスペース作成＋Claude）
          </Button>
        )}
        <Row gap="xs" wrap>
          <Button variant="outline" icon="open-external" onPress={() => shell.openExternal(task.url)}>
            Asana で見る
          </Button>
          {read(confirmComplete) ? (
            <>
              <Button tone="success" icon="check" onPress={() => completeTask(task)}>
                完了にする（確定）
              </Button>
              <Button variant="ghost" onPress={() => set(confirmComplete, false)}>
                やめる
              </Button>
            </>
          ) : (
            <Button variant="outline" icon="check" onPress={() => set(confirmComplete, true)}>
              完了にする
            </Button>
          )}
        </Row>
      </Stack>
    </Card>
  )
}

export default function Panel() {
  const s = read(status)
  const list = read(tasks)
  const working = read(busy)
  const err = read(error)
  const current = list?.find((t) => t.gid === read(selected)) ?? null

  if (!s) return <Skeleton lines={4} label="読み込み中" />

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Text weight="semibold">{s.me ? `Asana: ${s.me}` : 'Asana'}</Text>
        <Row gap="xs">
          {working ? <Spinner label={working} labelHidden /> : null}
          {s.hasToken ? (
            <>
              <IconButton icon="refresh" label="再読み込み" disabled={!!working} onPress={refresh} />
              <IconButton icon="settings" label="トークンを削除" variant="ghost" onPress={clearToken} />
            </>
          ) : null}
        </Row>
      </Row>

      {err ? (
        <Callout tone="danger" title="エラー">
          {err}
        </Callout>
      ) : null}
      {s.error ? (
        <Callout tone="danger" title="Asana に接続できません">
          {s.error}
        </Callout>
      ) : null}

      {!s.hasToken ? (
        <TokenForm />
      ) : (
        <>
          <Select
            label="ワークスペースを作るリポジトリ"
            placeholder="選んでください"
            value={read(repoId) || undefined}
            options={read(repos).map((r) => ({ value: r.id, label: r.name }))}
            onChange={(v) => set(repoId, v)}
          />
          {list === null ? (
            <Skeleton lines={6} label="タスクを読み込み中" />
          ) : (
            <Table
              label="自分のタスク"
              columns={[
                { key: 'name', label: 'タスク' },
                { key: 'due', label: '期限', width: 'sm' },
                { key: 'ws', label: 'WS', width: 'xs', align: 'center' }
              ]}
              rows={list.map((t) => ({
                key: t.gid,
                cells: { name: t.name, due: t.dueOn ?? '', ws: t.workspace ? '●' : '' }
              }))}
              selectionMode="single"
              selected={current ? [current.gid] : []}
              onSelectionChange={({ keys }) => {
                set(selected, keys[0] ?? null)
                set(confirmComplete, false)
              }}
              onRowAction={({ key }) => set(selected, key)}
              emptyText="未完了のタスクはありません"
              maxHeight="lg"
            />
          )}
          {current ? <TaskActions task={current} /> : null}
        </>
      )}
    </Stack>
  )
}
