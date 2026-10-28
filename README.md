# ivrm-ai

`ai.ivrm.jp` で提供する、ivRooom メンバー向けの Web 版 AI チャットエージェント。

- 利用者: 特定のロール / ポリシーが付与されたメンバーのみ
- LLM: Amazon Bedrock で利用できるモデルに限定(Claude / OpenAI / DeepSeek など。切り替え可能)
- 将来: Gemini など Bedrock にないモデルは、直接 API として別途検討する(現スコープ外)
- コスト: 既存 AWS 予算の範囲内。アプリ側の上限を必ず通す(`docs/design.md` §5)

状態(2026-10-28、Repository と本番で確認): **本番で稼働中**。`ai.ivrm.jp` は Cloudflare Tunnel から EC2 の Caddy、さらに `ivrm-ai` コンテナへつながっています。専用 PostgreSQL へは TLS(verify-full)で接続します。migration は `0002` まで適用済みです。実装済みの範囲は次のとおりです。

- 認証/Policy 判定クライアント
- Bedrock Converse
- Cost Gate
- PostgreSQL への会話・利用量・監査の保存
- Kill Switch
- 使用量の月次集計(`0003`)
- チャット UI
- 管理用モデルカタログ API

呼べるモデルは、単価を確認済みの gpt-oss 120B、DeepSeek V3.2(有効期限 2026-11-19)、Claude Haiku 5.5(日本の推論プロファイル、有効期限 2026-11-27)です(`src/models/default-catalog.ts`)。期限を過ぎると、価格を確認し直すまで呼べなくなります(fail closed)。Claude Sonnet 5.5 は東京に global の推論プロファイルしかなく、国外で推論されうるため入れていません(#13)。本番での Bedrock の実呼び出しの確認は #26 で行います。手順と状態は [`docs/deploy.md`](docs/deploy.md) を見てください。

## 開発

Node.js 22 と pnpm を使います(`packageManager` を参照)。

```sh
pnpm install --frozen-lockfile
pnpm typecheck      # サーバーと web/ の型検査
pnpm format:check   # Prettier
pnpm test           # Vitest。TEST_DATABASE_URL が無いと PostgreSQL のテストは skip
pnpm build          # dist/(サーバー)と dist/public(web)
```

CI(`.github/workflows/ci.yml`)では、上の 4 つを PostgreSQL 17 つきで実行します。続けて本番イメージの build・migrate・起動を確認します。この repository に `lint` script はありません。

### PostgreSQL のテスト

`src/db/postgres.test.ts` は、`TEST_DATABASE_URL` のデータベースの `public` schema を毎回作り直します。そのため、名前に `test` を含むデータベースにしか接続しません。使い捨ての PostgreSQL を使ってください。

```sh
docker run -d --rm --name ivrm-ai-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=ivrm_ai_test -p 55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/ivrm_ai_test pnpm test
docker rm -f ivrm-ai-pg
```

### 実行時の設定と運用コマンド

- サーバーの設定は `src/config.ts` が検証します。必須は `DATABASE_URL` です。本番では `AI_POLICY_MODE=api` 以外を拒否します。
- `pnpm db:migrate`(`dist/db/migrate-cli.js`)は、`DATABASE_MIGRATION_URL` を優先して使い、無ければ `DATABASE_URL` を使います。サーバー起動時には実行されません。
- `pnpm ops:kill-switch` と `pnpm ops:usage-retention` は運用 CLI です。本番での使い方と、承認が必要な操作は `docs/deploy.md` にあります。

## ドキュメント

- [`AGENTS.md`](AGENTS.md): このリポジトリでの作業ルール
- [`docs/design.md`](docs/design.md): 全体設計、歴史的な計画と現行の実装差分
- [`docs/deploy.md`](docs/deploy.md): 現行の本番デプロイ前提条件、未実施項目、ロールバックと緊急停止、実装順序

## 関連リポジトリ

| リポジトリ          | 関係                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `ivRooom/ivrm-web`  | 認証(`api.ivrm.jp`)、EC2 ランタイム、Terraform、コスト予算        |
| `ivRooom/Herta`     | IAM(グループ / ポリシー)、AI Foundation(コスト上限の設計の参照元) |
| `ivRooom/ivrm-contracts` | サービス間の API 契約                                        |
| `ivRooom/ivrm-platform`  | 全体アーキテクチャ / サービスカタログ                        |
