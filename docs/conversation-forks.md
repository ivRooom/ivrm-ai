# 編集・再生成 — 元会話を残す分岐

Issue #31。PR #62のUIを前提とするstacked変更。

`POST /api/conversations/:id/fork { messageId, modelId }` は、基準userより前の全履歴を
新会話へコピーし、元質問をdraftとして返す。編集dialogの「分岐して送信」、回答の
「もう一度生成」は、返された新会話へ既存sendを一度だけ行う。元会話は変更しない。
通常の回答生成として既存モデル認可/価格検証/CostGate/予約・精算/kill-switchを通す。

PostgresはREPEATABLE READ + source/project shared lockで一貫したsnapshotを使う。
copy中の失敗はconversation作成もrollback。新message IDを発行し、過去のusage/costを
コピーしない。200件/512KiBを超えるprefixは413拒否。履歴を黙って切り詰めない。
現在のproject instructionsを使用し、過去と完全に同じ推論設定を再現する機能ではない。

Storage-copy専用guardはownerあたり同時1件・6件/分・50件/24h、最大1024ownerのmap。
拒否時は429/Retry-After。単一process内の抑制で、再起動/複数instanceを跨ぐ永続quotaではない。
forkには自動retryを設けない。通信結果不明時は一覧確認を案内。生成拒否時はdraftを保持。
元会話への戻りリンクはその画面のsession内のみ。DBへ分岐系譜は保存しない。

検証: local 181 pass/34 PG skip、typecheck/build/format pass。共通store contractでowner、
message所属/role、archive、200/201件、UTF-8 512KiB、元履歴不変を検証。
PG専用testはcopy失敗rollbackと課金列NULLを確認（CIで実行）。UI結合testはedit/regenerate、
一度だけの送信、旧回答除外、gate拒否時draft保持。real Hono routes+Memory+CostGate+
synthetic modelのloopback previewで編集/再生成/保存/元会話へ戻る操作を確認。AWS呼出なし。

`pnpm build` → `pnpm exec tsx scripts/preview-chat.ts` で再現可能。NODE_ENV=productionは拒否。
証跡: `docs/evidence/forks/`。本番未変更、DB migrationなし。Rollbackは本PR revert。
merge順: UI #62 → fork PR。Deployは統合したmain CIとhuman approval後、migrationなし。
