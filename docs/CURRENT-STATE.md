# Current State — 2026-11-11 JST

GitHubが動的状態の正本。このファイルは作業checkpoint。

- Issue: [#61](https://github.com/ivRooom/ivrm-ai/issues/61)。branch `codex/premium-chat-workspace`。
- Writer: primary Codex。独立read-only audit/reviewer: Codex subagent。実装詳細・棚卸し・視覚評価:
  [premium-workspace.md](premium-workspace.md)。
- 実装: Workspace/Sidebar/Composer再配置、Light/Dark/System、title PATCH、copy/export、title filter。
  アーカイブ送信のserver側拒否。DB migration/契約破壊/新providerなし。
- ローカル: typecheck/build、170 unit/API tests pass、29 Postgres tests skip、audit既知脆弱性なし。
  新規画面7size×2theme、fixture操作確認。CI/merge/deployはGitHubで最新取得。
- Production変更: なし。前回Deploy run `42858199443` success、SHA `6cc0539`。
  現行配信CSSは同SHAのGit blobと一致。本番新規画面閲覧のみ、AI呼出なし。
- 未完了: CI/人間review/security、全面a11y/E2E、全文検索・編集/再生成・所属変更・添付。
- 次の3タスク: (1) #61 PRの最新CI/security/レビュー確認、(2) #31履歴境界と再生成/edit設計、
  (3) owner制約付き全文検索APIを独立Issue/PRで実装。
- 本番Deployは明示承認後。Rollback: revert +正式Deploy（migrationなし）。

## PR / CI checkpoint

PR [#62](https://github.com/ivRooom/ivrm-ai/pull/62)。初回HEAD `818f5b2` の
[CI](https://github.com/ivRooom/ivrm-ai/actions/runs/42864745210)はcheck/image success、
Postgres17込み199/199 tests pass。Semgrep success。Snykはprivate tests quota error、
人間approvalなし。未merge/未deploy。最新HEADの結果をPRで再確認する。
最終SVG版のviewportスクリーンショットをtransition完了後に再取得。

## v2 再設計

前回案への『まだ弱い』フィードバックに対応。Shell/Sidebar/Welcome/Composer/Messageを
再設計しcode copy/PC nav collapse/prompt startersを追加。詳細と新証跡はpremium-workspace.md。
#31の編集・再生成は元会話保持のfork方式で別PRへ。未merge/未deploy。

## プロフィール兼ホーム

#63でプロフィール、利用統計、365日ヒートマップ、モデル実績、プロジェクト・最近の会話を実装。
#62 UI、#64 編集・再生成に続く変更。元の会話を残す分岐のコピーは統計に再加算しない。
docs/profile-home.md と証跡を参照。ローカル186件成功、35件はPostgreSQL CIで実行。
本番変更なし。次は最新CIとレビュー確認、承認後に #62 → #64 → プロフィールPR を統合。
