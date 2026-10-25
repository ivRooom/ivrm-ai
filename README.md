# ivrm-ai

`ai.ivrm.jp` で提供する、ivRooom メンバー向けの Web 版 AI チャットエージェント。

- 利用者: 特定のロール / ポリシーが付与されたメンバーのみ
- LLM: Amazon Bedrock で利用できるモデルに限定(Claude / OpenAI / DeepSeek など。切り替え可能)
- 将来: Gemini など Bedrock にないモデルは、直接 API として別途検討する(現スコープ外)
- コスト: 既存 AWS 予算の範囲内。アプリ側の上限を必ず通す(`docs/design.md` §5)

状態（2026-10-26、Repositoryのmainで確認）: **M0のAPI実装と単体テストが存在**。認証/Policy判定クライアント、Bedrock Converse、Cost Gate、PostgreSQL会話保存・利用量・監査、DB migration、Kill Switchがコード化されています。ただし**本番デプロイと専用PGへの接続・Cloudflare経路の成立は未確認／必要条件が残存**します。`docs/deploy.md`を参照してください。

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
