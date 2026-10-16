# ivrm-ai

`ai.ivrm.jp` で提供する、ivRooom メンバー向けの Web 版 AI チャットエージェント。

- 利用者: 特定のロール / ポリシーが付与されたメンバーのみ
- LLM: Amazon Bedrock で利用できるモデルに限定(Claude / OpenAI / DeepSeek など。切り替え可能)
- 将来: Gemini など Bedrock にないモデルは、直接 API として別途検討する(現スコープ外)
- コスト: 既存 AWS 予算の範囲内。アプリ側の上限を必ず通す(`docs/design.md` §5)

状態: **設計段階**。実装は未着手。

## ドキュメント

- [`AGENTS.md`](AGENTS.md): このリポジトリでの作業ルール
- [`docs/design.md`](docs/design.md): 全体設計、決定事項、未決事項、実装順序

## 関連リポジトリ

| リポジトリ          | 関係                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `ivRooom/ivrm-web`  | 認証(`api.ivrm.jp`)、EC2 ランタイム、Terraform、コスト予算        |
| `ivRooom/Herta`     | IAM(グループ / ポリシー)、AI Foundation(コスト上限の設計の参照元) |
| `ivRooom/ivrm-contracts` | サービス間の API 契約                                        |
| `ivRooom/ivrm-platform`  | 全体アーキテクチャ / サービスカタログ                        |
