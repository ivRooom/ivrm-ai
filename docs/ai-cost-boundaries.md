# AI コスト統制の分界

この文書は、ivRooom の AI 予算統制が「どの系統が・何を・どう数えるか」の分界の正本。
経緯と調査結果は [#86](https://github.com/ivRooom/ivrm-ai/issues/86) の
[調査コメント](https://github.com/ivRooom/ivrm-ai/issues/86#issuecomment-6841581776) を参照。

## 結論

AI の予算統制は一系統ではなく三系統あり、対象・台帳・単位がすべて異なる。
**統合しない。** 三系統はそれぞれ独立に維持し、この文書で分界を明文化する。
概念（予約 → 実行 → 精算、検証済み価格のみで計上、未知の使用量は解放しない）は
三系統とも既に満たしており、共通化の実利は実装の寄せ集めではなく
用語と原則の明文化にある。

## 分界表

| 項目 | Herta AI Foundation | ivrm-ai Cost Gate | Platform BudgetGuard |
| --- | --- | --- | --- |
| 所有 repo | ivRooom/Herta | ivRooom/ivrm-ai | ivRooom/ivrm-platform |
| 対象トラフィック | Discord Bot の AI 会話・コード実行・画像生成 | Web チャット（ai.ivrm.jp） | sandbox 内の Hermes セッション（AI 開発基盤） |
| 課金単位 | ギルド | ユーザー | セッション |
| プロバイダ | 6 社の直接 API（OpenAI / Anthropic / Google / Moonshot / xAI / DeepSeek。Bedrock なし） | Amazon Bedrock のみ | Bedrock（東京リージョン固定）＋ OpenAI 互換の外部プロバイダ（Google AI Studio / OpenRouter） |
| 台帳の置き場 | Redis（24h 窓の quota を reserve / settle）＋ Herta DB（ギルド月次予算） | PostgreSQL `ivrm_ai` | SQLite |
| 上限の性質 | ギルド月次予算 ＋ 24h 窓 quota | per-request $0.12 / ユーザー日次 $0.50 / 全体月次 $15（アカウント予算 $67 の内側） | 生涯累積 $20（リセットなし） |
| 緊急停止の仕組み | config の enabled / kill switch（env `HERTA_AI_KILL_SWITCH`） | DB `ops_flags` の `kill_switch` ＋ CLI。変更は監査ログに記録 | 既定で無効（`enabled=False`）。再有効化には人間承認の migration が必要 |
| fail の向き | 予算 DB 障害時は fail-open | fail-closed | 既定無効。承認なしに有効化されない |
| 実装 | `packages/plugin-catalog/src/ai-service.ts`（AiFoundationService）、`apps/bot/src/ai/ai-budget-guard.ts` | `src/cost/gate.ts`、`src/cost/limits.ts`、`src/ops/kill-switch.ts`、`src/models/bedrock.ts` | `packages/ai-development/src/ivrm_ai/budget.py`、`hermes_gateway.py` |

注記: 上表の金額はコード上の既定値（例: ivrm-ai の `DEFAULT_LIMITS`）。
本番 env での実効値の確認は各系統の運用側の対象であり、この文書の対象外。

## 用語ルール

- 予算統制を指すときは、必ず系統名で呼ぶ:
  **Herta AI Foundation** / **ivrm-ai Cost Gate** / **Platform BudgetGuard**。
- 無修飾の「ゲートウェイ」「Budget Guard」「コスト管理」を正本名として使わない。
  三系統のどれを指すか判別できず、誤った統合や誤った上限の適用を招くため。
- Issue・PR・設計文書では、系統名に所有 repo を併記する。

## 固有制約

- **Platform BudgetGuard の生涯累積 $20 上限は統制要件そのもの。**
  累積・リセットなし・自動リセットなしが仕様であり、月次型の上限を持つ
  他系統の方式へ寄せると壊れる。引き上げ・リセット・再有効化はいずれも
  人間承認を必要とし、コード上もその形で強制されている。
  Bedrock の利用はこの枠内での補助用途（短い分類・要約・ログ分析・軽いレビュー）に限る。
- **課金帰属を分離する。** 開発系（Platform BudgetGuard）の課金を
  Herta / ivrm-ai の利用に帰属させない。逆も同様。
  platform 側台帳の `reconcile()` 自身がこの分離を明記しており、運用要件である。
  台帳同士を混ぜたり、残高を相殺したりしない。

## #28（RAG 契約）との関係

[#28](https://github.com/ivRooom/ivrm-ai/issues/28)（RAG と Herta 連携の契約）は
本分界とは別軸の課題。将来の連携は契約 API 経由とし、連携後も各側の予算統制は
それぞれ残す。連携を理由に台帳・上限・緊急停止を統合しない。

## 統合を再検討するトリガー条件

次のいずれかが別途決まった場合に限り、統合の再検討を行う。
それ以外では再検討しない。

- 対象トラフィック自体の統合が決まった場合
  （例: Discord と Web のチャット面の一本化）。
- 台帳基盤の共通化（共通 DB / 共通台帳サービス）が別途決定された場合。
- いずれかの系統の廃止・移管が決まった場合。

再検討する場合も、まず本書を更新して分界の変更を合意してから実装に着手する。
