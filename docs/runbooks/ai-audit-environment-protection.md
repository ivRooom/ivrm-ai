# ivrm-ai GitHub OIDC監査Environment｜本番導入前チェック

Source of Truth: [ivrm-ai #53](https://github.com/ivRooom/ivrm-ai/issues/53), [Infra #59](https://github.com/ivRooom/ivrm-infrastructure/issues/59), [Infra #37](https://github.com/ivRooom/ivrm-infrastructure/issues/37).

## 目的と現在地
人間用 `IVRM-ReadOnly` は CloudFormation修復後のCLI受入 PASS。これはGitHub CI workloadやChatGPT AWS Core認証ではない。
`ivrm-ai`監査Workflowは `aws-ai-audit` のみを使用し、既存 `aws-runtime` 本番Deploy Roleを再利用しない。AWS Role `ivrm-ai-github-audit-readonly-role` は **未作成（実 IAM GetRole NoSuchEntity）**。既存のChatGPT AWS Core連携は3つともRoot。

## GitHub所有者の操作（現時点では設定確認・変更だけ。監査Workflowは起動しない）
1. [GitHub Settings → Environments](https://github.com/ivRooom/ivrm-ai/settings/environments) を開く。
2. `aws-ai-audit` が**事前に存在**することを確認。ない場合、`New environment` → `aws-ai-audit` とする。
3. `Deployment branches and tags` は **Selected branches and tags** に設定し、許可パターンは**正確に `main` のみ**。タグ、ワイルドカード、別Branchの許可なし。
4. **個人開発（SOLO_MANUAL）では `Required reviewers` OFF、Wait timer OFF を許可**。`Allow administrators to bypass configured protection rules` は**必ずOFF**にして保存する。レビュアーを用意できないのに架空の独立承認があると扱わない。複数人に拡張した場合のみ、実際の別レビュアーと `Prevent self-review` を推奨・検証する。これはGitHubの独立承認に代わるものではなく、監査Job限定の例外。
5. 既存 `aws-runtime` Environmentは変更しない。GitHub Environment SecretsやAWS長期Access Keysは登録しない。
6. Environment Variables `AWS_REGION`、`AWS_ACCOUNT_ID`、`AWS_AI_AUDIT_ROLE_ARN` は**IAM Roleを非Rootで実作成したあと**に正確な値を登録（Account ID/Role ARNを公開Issueへ転記しない）。`AWS_REGION=ap-northeast-1`。
7. 本番Goal: AWS側OIDC Trust `repo:ivRooom/ivrm-ai:environment:aws-ai-audit` と `aud=sts.amazonaws.com`、GitHub environmentのmain限定・管理者バイパス禁止、1時間以内の短期Credential、IAM Boundary、CloudTrailが一致すること。

## GitHub CLIで設定だけを読み取り検査する（オプション）

GitHub CLI (`gh`) をすでに利用でき、本人の正規認証がある場合のみ。**GET API以外は実行しない。**

```powershell
Set-Location 'Z:\src\ivRooom\ivrm-ai'
$dir = Join-Path $env:TEMP 'ivrm-ai-audit-env'
New-Item -ItemType Directory -Force $dir | Out-Null
$envfile = Join-Path $dir 'environment.json'
$branchesfile = Join-Path $dir 'branches.json'
gh api 'repos/ivRooom/ivrm-ai/environments/aws-ai-audit' | Set-Content -Path $envfile -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'GitHub Environment GET failed' }
gh api 'repos/ivRooom/ivrm-ai/environments/aws-ai-audit/deployment-branch-policies?per_page=100' | Set-Content -Path $branchesfile -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'GitHub Branch Policies GET failed' }
py -3 .\scripts\check-ai-audit-environment.py --environment-json $envfile --branch-policies-json $branchesfile
```

出力が `ADVISORY_READY_NOT_RELEASE` でも **AWS IAMを操作する許可ではない**。取得したJSONにはレビュアー名等があり得るためコミット・公開Issue添付はしない。検査結果の `configuration` と `errors` のみ記録する。

検査が失敗した場合、無条件に保護設定を緩めたりWorkflowを実行して自動生成させない。GitHubは公開/非公開と契約プランによりReviewer Protection利用可否が異なる。[GitHub公式 Environments](https://docs.github.com/en/rest/deployments/environments), [Deployment Branch Policies](https://docs.github.com/en/rest/deployments/branch-policies) を参照。

## AWS Role Terraformを実際に適用する前のゲート
- [ ] 事前に作成され保護された GitHub `aws-ai-audit` 。
- [ ] Remote Terraform S3 state は暗号化・Versioning・Locking・Backup/Restore可、隔離key（Web/DBとは別）。Source `ivrm-infrastructure/terraform/aws/ai-readonly`。
- [ ] 実体が確認済みの非Root IAM Administratorでの`terraform plan` を保存し、Diff/Policy/Trustを自身による明示的な変更レビューと保存済みPlanの照合（独立レビューではない）。`creation_approved=false` での不許可がデフォルト。承認と正確なPlanが揃ってからのみ明示許可。
- [ ] CloudTrail/STS/権限否定Simulator・個別無効化とRollback。確認無しで `creation_approved=true` にしない。
- [ ] 既存Root AWS Coreは別Connectorの非Root認証が実証されるまで維持し、Root権限での更新は行わない。GitHub専用RoleをChatGPT/Claude/Codex/Kiroへ転用しない。

## Soloモードのリスクとリリース制約
- `Required reviewers` を無効にしてもEnvironmentへのJobアクセスは自動許可される。これは**ブランチやメタデータのみの監査Job**に限る判断であり、AWSへの権限昇格やTerraform ApplyをGitHub Actionsに委任してはいけない。
- Repoの `main` ブランチ保護・Rulesetが維持されていることを別途確認し、workflowを書き換えてmainへ直接投入できる攻撃経路を考慮する。
- Jobは `workflow_dispatch` + 入力 `AUDIT` + `refs/heads/main` の組み合わせに限定。Role Trustは専用environmentのOIDC sub/audと最小Action、短時間セッションに限定。監査Jobはwrite APIを使わない。
- `ADVISORY_READY_NOT_RELEASE` はGitHub設定の静的確認結果のみ。IAM Role未作成、実STS/CloudTrail/失効の試験未完了であれば、**本番監査はNO-GO**。
- User screenshot (2026-11-04): `aws-ai-audit` Updated、mainのみ1 branch・0 tags、レビュアーOFF、bypass OFF。REST JSONの独立取得は未確認。
