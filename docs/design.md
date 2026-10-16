# ivrm-ai 設計 v0.1

状態: ドラフト(実装前)。決定事項と未決事項を分けて書く。

## 1. 目的と非目的

目的:

- `ai.ivrm.jp` で、ChatGPT / Claude のような Web 版 AI チャットを、許可されたメンバーに提供する。
- Bedrock 上の複数モデルを切り替えて使える。
- チャットのプロジェクト、アーカイブ、MCP、エージェント、RAG を段階的に提供する。

非目的(現スコープ外):

- Bedrock にないモデル(Gemini など)の利用。将来、直接 API として別途検討する(§4.3)。
- 全メンバーへの公開。利用者は特定ロール / ポリシー保持者のみ。
- Herta Bot との統合。Herta の Discord AI 機能は別系統のまま。

## 2. 確認済みの前提

2026-10-16 時点で、各リポジトリ / AWS を確認した事実。

- ivrm-web の Home / Admin / Member / API は、EC2 1 台の Docker Compose + Caddy で動く。
  デプロイは GitHub Actions → OIDC → ECR → SSM。(`ivrm-web/docs/infra/architecture.md`)
- 認証は `api.ivrm.jp` の Discord OAuth。セッション cookie `ivrm_admin_session` は `Domain=.ivrm.jp` で共有される。
- AWS の月額予算はアカウント全体で **$67**。**100% で本番 EC2 が自動停止**し、自動復旧しない。
  Bedrock 費用もこの予算に含まれる。(`ivrm-web/docs/operations/aws-cost-budget-guardrails.md`)
- Herta は AI Foundation を持つ。provider 抽象、コスト事前予約と実績精算、レート / クォータ / 同時実行の上限、
  kill switch、fail closed が実装・文書化済み。(`Herta/docs/AI_FOUNDATION.md`)
  Herta の既定上限は、1 リクエスト $0.12、Guild あたり $1 / 24 時間など。
- **Herta に RAG は未実装**(`Herta/docs/AI_FOUNDATION.md`、`BEDROCK_RAG_EVALUATION.md`)。
  したがって RAG は ivrm-ai が先に持つ。Herta の RAG との連携は、Herta 側に RAG ができてから契約化する。
- Herta の Bedrock 評価メモは「Bedrock は OpenAI / Google / Moonshot 非対応」と書くが、**現在は古い**。
  2026-10-16 の `ListFoundationModels` では OpenAI(GPT-5.x / 6.x / gpt-oss)と DeepSeek が提供されている(§4)。

## 3. 全体構成

```text
ai.ivrm.jp (Caddy, EC2)
 ├─ web      チャット UI(SSE ストリーミング)、プロジェクト、アーカイブ
 ├─ gateway  認証・認可・コスト関門・レート制限・監査ログ
 ├─ agent    エージェントループ(Bedrock Converse API + tool use)
 ├─ mcp      MCP クライアント / 自前 MCP サーバー
 └─ db       会話・プロジェクト・エージェント定義・利用量・RAG(pgvector)
```

- 認証は既存の `api.ivrm.jp` を使う。ivrm-ai 側は cookie を検証し、ロール / ポリシーを確認する。
- ivrm-web 側に必要な変更(別 PR): `return_to` と CORS の許可リストへ `https://ai.ivrm.jp` を追加。

## 4. モデル(Bedrock 限定)

### 4.1 利用できるモデル

2026-10-16 の `ListFoundationModels`(ap-northeast-1 / us-east-1 / us-west-2)による提供カタログ。
**アカウントでのモデルアクセス承認は未確認**であり、承認の有無は実装時に確認する。

| 系統     | Tokyo (ap-northeast-1)                                         | 備考                                       |
| -------- | -------------------------------------------------------------- | ------------------------------------------ |
| Claude   | Fable 5.1、Opus 5.5、Sonnet 5.5、Haiku 5.5 ほか(inference profile) |                                            |
| OpenAI   | GPT-5.4〜6.1 系(inference profile)、gpt-oss-120b / 20b         |                                            |
| DeepSeek | V3.2                                                           | **R1(推論)は us リージョンのみ**           |
| その他   | Nova、Qwen3、Mistral、Gemma など                               | Gemma は Gemini ではなくオープンウェイト   |

### 4.2 切り替えの設計

- 呼び出しは Bedrock **Converse API** に統一する。モデルごとの SDK 分岐を作らない。
- `models` 設定(コードレビュー対象のファイル)で、モデルごとに次を宣言する:
  Bedrock のモデル ID / inference profile、リージョン、入出力単価、最大出力、tool use・推論・画像の対応可否、利用可能なポリシー。
- 設定にないモデルは呼べない(allowlist)。クライアントから任意のモデル文字列を受け付けない。
- 単価はコード内の定数とし、期限(価格の確認日)を持たせる。期限切れの価格は fail closed にする
  (Herta の `gpt-5.6-sol` の扱いと同じ考え方)。
- リージョンをまたぐモデル(DeepSeek R1 など)は、データの越境があるため、ポリシーで明示許可したものだけ有効にする。

### 4.3 Bedrock 外のモデル(将来)

Gemini など。直接 API のため、Bedrock の IAM 認証・AWS 請求の外になる。導入時は次を別途設計する:
API キーの保管、コスト関門への組み込み、データ送信先の明示。`models` 設定の provider 抽象を最初から切っておき、
今は Bedrock の実装だけを置く。

## 5. コスト関門(必須)

LLM 呼び出しはすべて、次の関門を通る。通らない経路を作らない。

1. 認可: ログイン済み、かつ `ai:use` を持つ。
2. モデル allowlist と、そのモデルの利用権限。
3. 事前予約: 入力バイト長を保守的な代理にして最大コストを見積もり、上限を超えるなら拒否する。
4. 上限: ユーザー別の日次 / 月次、全体の月次、同時実行数、レート。
5. 精算: 完了後、Bedrock が返す usage で実コストに置き換える。
6. kill switch: 環境変数 / 設定で全呼び出しを止められる。
7. 判断できない場合(価格期限切れ、DB 障害、計測不能)は **拒否**する。

AWS 側の保険(承認後に Terraform で作成):

- モデル系統ごとの application inference profile + コスト配分タグ。
- ai 専用の AWS Budget(例: $20/月)。上限到達で、ai の IAM ロールに Bedrock の Deny を付ける。
  **EC2 は止めない。**
- 既存の $67 予算の見直しが必要かは、運用者が判断する(別 PR、別承認)。

初期の目安(要調整): ユーザー日次 $0.5、全体月次 $15。高価なモデルは Owner / Admin のみ。

## 6. 認可

**判定点(PDP)は `api.ivrm.jp`**。ivrm-web には IAM 風のポリシー評価
(`packages/permissions/src/policy.ts`: 既定 Deny、明示 Deny 優先、条件は fail closed)と、
管理画面から付与できる保存済みポリシー(editorial grants)がある。ivrm-ai はこれに従う。
Herta IAM は Herta Studio の権限を決めるもので、ivrm-web の admin から管理する連携先の 1 つ。
ivrm-ai は Herta を直接呼ばず、`api.ivrm.jp` に問い合わせる。

- ivrm-ai は、ユーザーの cookie を付けて `api.ivrm.jp` に「`ai:Use` / リソース `ivrm:ai:*` は許可か」を問い合わせる。
  応答は許可 / 拒否と理由のみ。ivrm-ai 側にポリシー本体は持たない。
- アクション名: `ai:Use`(利用)、`ai:UseModel`(リソース `ivrm:ai:model/<id>`)、`ai:UseTool`(リソース `ivrm:ai:tool/<name>`)。
- **現状、この判定 API は存在しない**。ivrm-web 側に追加する(別 PR。producer: ivrm-web、consumer: ivrm-ai)。
  その間、ivrm-ai は判定点をインターフェース(`PolicyDecisionClient`)で抽象化し、
  判定 API が使えない場合は**拒否**する(fail closed)。固定の許可実装はテスト専用で、本番では有効にできない。
- ツール: 呼び出しはログインユーザーの権限で行う。サービスアカウントで代行しない。
- 監査: 会話の開始、ツール呼び出し、書き込み、コスト精算を、ユーザー ID 付きで記録する。

## 7. RAG

- 現状データは未収集。まず**取り込みの仕組みと検索 API の形**だけ決める。
- ベクトルストアは pgvector を第一候補とする(同じ Postgres に置ける)。
  Herta の評価メモにある Aurora Serverless v2 は月 $40〜60、OpenSearch Serverless は月 $700 前後の目安で、
  **$67 の予算では採用できない**。
- 文書には ACL(閲覧できるロール / ポリシー)を付け、検索時に利用者の権限で絞る。
- 取り込んだ文書は**データ**として扱い、文書中の指示に従わない(プロンプトインジェクション対策)。
- Herta との連携は、Herta に RAG ができた時点で、`ivrm-contracts` に検索 API の契約を追加して行う。
  埋め込みモデルの統一と、ACL をどちら側で強制するかを、その時に決める。

## 8. 機能と順序

| 段階 | 内容                                                            |
| ---- | --------------------------------------------------------------- |
| M0   | 基盤: 認証、モデル切り替え、コスト関門、会話保存、監査ログ      |
| M1   | チャット UI(ストリーミング)、プロジェクト、アーカイブ           |
| M2   | MCP(読み取り専用の自前サーバーから)、エージェント定義          |
| M3   | RAG(取り込み、検索、ACL)                                        |
| M4   | ブラウザ操作 / computer use(隔離した実行環境が前提、§9)         |
| M5   | RC(リモートコントロール)。**要件未確定。下記の未決事項を参照**  |

## 9. 実行環境の隔離

ブラウザ操作と computer use は、本番 EC2(home / api / contact が同居)に置かない。
別インスタンスまたはオンデマンド起動のサンドボックスで動かし、ネットワークを制限し、ユーザー権限の範囲に絞る。
書き込み・外部送信・購入などは毎回確認する。ページ内の指示は指示として扱わない。

## 10. インフラ

- ホスティングは EC2(ivrm-web と同じ Caddy / Docker Compose / ECR / SSM のパターン)。
  Herta と同居しない(負荷と障害の分離)。
- 既存の本番 EC2 に同居させるか、ai 専用インスタンスにするかは**未決**(§11)。
  同居なら、`ai` の負荷が本番に影響しないよう、メモリ上限とプロセス分離を設ける。
- DNS は Cloudflare。`ai.ivrm.jp` を EC2 に向ける。
- Terraform apply、DNS 変更、IAM 作成は、承認を得て別 PR で行う。

## 11. 決定事項と未決事項

2026-10-16 に運用者が決定(#7)。

| 項目                  | 決定                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| 実行場所              | **ai 専用 EC2**(本番 EC2 と分離)。ai 専用 Budget と併用する                                     |
| DB                    | **ai 専用 Postgres**(EC2 上のコンテナ、pgvector)。他サービスの DB には触れない。バックアップは自前 |
| 利用許可              | **最初からポリシーで判定する**(ロールの allowlist ではない)。判定点は §6                        |
| RC                    | **ivrm-ai のセッションを別端末から操作する**機能(実行中の作業の閲覧・承認・停止)。M5            |
| 言語 / フレームワーク | TypeScript / Node 22+ / pnpm。HTTP は Hono                                                        |

未決:

| 項目                       | メモ                                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| 判定 API                   | §6。`api.ivrm.jp` に `ai:Use` の判定 API が必要(ivrm-web 側の別 PR)         |
| AWS 予算の見直し           | 既存 $67 を上げるか、ai 専用 Budget のみで運用するか                         |
| 本番 DB のバックアップ方式 | S3 へのダンプ(世代管理)を想定。詳細は別 Issue                              |

## 12. 次の作業(Issue 化)

1. M0: 認証(cookie 検証)+ ポリシー判定の最小実装
2. M0: Converse API のモデルアダプタと `models` 設定
3. M0: コスト関門(事前予約 / 精算 / 上限 / kill switch)
4. M0: 会話保存と監査ログのスキーマ
5. ivrm-web: `ai.ivrm.jp` を許可リストへ追加(別リポジトリ)
6. Terraform: ai 専用 Budget、inference profile、IAM(承認後・別 PR)
