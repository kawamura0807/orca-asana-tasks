# Asana Tasks (Orca plugin)

自分に割り当てられた Asana の未完了タスクを Orca の右サイドバーに並べ、タスクからワークスペースを作って Claude に着手させるプラグイン。

## できること

- 未完了タスクを期限順に一覧（ワークスペース作成済みは「●」）
- 「着手」: `orca worktree create` でワークスペース（`asana-<gid>`）を作り、タスク説明と URL をプロンプトに Claude を起動。ワークスペース名はタスク名にする
- 「ワークスペースを開く」「Asana で見る」「完了にする」（2回押しで確定）

## 入れ方

```sh
orca plugin install kawamura0807/orca-asana-tasks   # 表示される --approve <fingerprint> を付けて再実行
```

初回はパネルで Asana の個人アクセストークン（https://app.asana.com/0/my-apps）を登録する。トークンは Orca の暗号化 secrets（OS キーチェーン）に保存され、リポジトリには入らない。

## 開発

```sh
orca plugin validate .
orca plugin test .
orca plugin check .
orca plugin dev load . --approve <fingerprint>
```

ワークスペース作成は、この Orca（host API 1.6）に `workspace.create` がないため `orca` CLI（`/Applications/Orca.app/Contents/Resources/bin/orca`、または `ORCA_CLI_COMMAND`）を呼んでいる。
