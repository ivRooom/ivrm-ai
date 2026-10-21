# Deploying ivrm-ai (production instance)

Decision (2026-10-21): ivrm-ai runs as **one Node container on the existing
production instance** (no dedicated server, no Postgres container). The database
is an external PostgreSQL (planned: the consolidated Lightsail database).
Move to a larger or dedicated instance when free memory gets short (see
"When to move").

Path: GitHub Actions (`Deploy`, manual) -> ECR `ivrm/ai` -> SSM -> Docker
Compose on the instance -> Caddy (`ai.ivrm.jp` -> `ivrm-ai:3100`).

## Prerequisites (each needs the operator's approval)

| What | Where | Status |
| --- | --- | --- |
| IAM policy (Bedrock invoke by model ARN, `/ivrm/ai/*` parameters, ECR pull), ECR repository `ivrm/ai` | ivrm-web `infra/terraform/environments/production/ai_runtime.tf` (ivrm-web#581) | applied 2026-10-21 (attached to `ivrm-ec2-role`) |
| Caddy route `ai.ivrm.jp` | ivrm-web `infra/aws/runtime/Caddyfile` (merged in ivrm-web#581), applied with the `AWS Home Edge` workflow | merged, not applied to the instance |
| Cloudflare Tunnel public hostname `ai.ivrm.jp` -> `http://localhost:8080` (like the other hosts) | Cloudflare Zero Trust | not done |
| GitHub OIDC role that trusts `ivRooom/ivrm-ai` and may push `ivrm/ai` and send SSM commands to the instance | IAM `ivrm-ai-github-deploy-role` (ivrm-web#584, `ai_deploy_role.tf`); trusts only the `aws-runtime` Environment | applied 2026-10-21 |
| Repository variables `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_ROLE_ARN`, `AWS_ECR_REPOSITORY` (`ivrm/ai`), `AWS_EC2_INSTANCE_ID`; Environment `aws-runtime` (main only) | this repository | not set |
| SecureString `/ivrm/ai/database-url` (`postgres://…`, `sslmode=verify-full`) | SSM | **blocked: database not ready** |
| Optional `/ivrm/ai/kill-switch` = `true` refuses every model call | SSM | absent = off |

## Release

1. Review the commit and its CI. Confirm the prerequisites above.
2. Actions -> **Deploy** -> Run workflow on `main`, `confirm_deploy` = `DEPLOY`.
   Tick `run_migrations` only when the release contains new SQL in
   `migrations/` and you approve changing the production database.
3. The script keeps the previous image and rolls back to it when the new
   container is not healthy, or when `/api/me` and `/api/models` do not answer
   401 without a session.

Rollback to an older release: run **Deploy** from a revert on `main` (images are
addressed by commit SHA and kept in ECR; the instance keeps the last image in
`/opt/ivrm/ai/current-image`).

## Limits on the shared host

- Container limits: 256 MB, 0.5 CPU (`infra/aws/docker-compose.yml`). The host
  had about 0.9 GB available on 2026-10-21 (CPU averaged 3% over 14 days).
- The Bedrock budget guard (monthly cap in `src/cost/limits.ts`) is unchanged.
- The instance role is shared with the other apps. The ivrm-ai policy only
  allows Bedrock invocation of the catalog's model ARNs, so adding a model
  needs the Terraform variable `ai_bedrock_model_ids` to change as well.

## When to move

Move to a larger instance or a dedicated one when free memory stays under
300 MB, or before adding anything that executes code (MCP servers, browser
operation, computer use): those must not share the production host.
