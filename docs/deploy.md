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
| Repository variables `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_ROLE_ARN`, `AWS_ECR_REPOSITORY` (`ivrm/ai`), `AWS_EC2_INSTANCE_ID`; Environment `aws-runtime` (main only) | this repository | set 2026-10-21 |
| SecureString `/ivrm/ai/database-url`: runtime role `ivrm_ai_runtime` (DML only), `postgres://…@<DB static IP>:5432/ivrm_ai?sslmode=verify-full&sslrootcert=/etc/ivrm-ai/db-ca.crt` | SSM (ivrm-infrastructure `docs/runbooks/postgresql-ai-client-route.md`; its `issue-cert` puts the DB static IP in the certificate's IP SAN, which `verify-full` checks) | **not created yet** |
| SecureString `/ivrm/ai/database-migration-url`: migrator role `ivrm_ai_migrator` (DDL), same shape; read only when `run_migrations` is on | SSM (same runbook) | **not created yet** |
| String `/ivrm/ai/database-ca-cert`: CA of the database server certificate (public), written to `/opt/ivrm/ai/db-ca.crt` and mounted at `/etc/ivrm-ai/db-ca.crt` | SSM (same runbook) | **not created yet** |
| Optional `/ivrm/ai/kill-switch` = `true` refuses every model call, fixed at deploy time (see "Emergency stop") | SSM | absent = off |

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

## Emergency stop (kill switch)

Two switches refuse every model call. Either one being on is enough.

- **Stored switch (no restart)**: the `ops_flags` row `kill_switch`
  (migration `0002_ops_flags.sql`). The server re-reads it every 5 seconds.
  Change it from inside the running container; each change is written to
  `audit_logs` (`ops.kill_switch.on` / `ops.kill_switch.off`) with the actor and
  reason:

  ```sh
  docker exec ivrm-ai node dist/ops/kill-switch-cli.js on --actor <who> --reason "<why>"
  docker exec ivrm-ai node dist/ops/kill-switch-cli.js off --actor <who> --reason "<why>"
  docker exec ivrm-ai node dist/ops/kill-switch-cli.js status
  ```

  Running a command on the production instance (SSM or a shell) needs the
  operator's approval as usual.

- **Deploy-time switch**: SSM `/ivrm/ai/kill-switch` = `true` becomes
  `AI_KILL_SWITCH=true` at the next Deploy. While it is set, the stored switch
  cannot turn calls back on.

Fail closed: until the first successful read at start, and whenever the database
has not answered for 30 seconds, calls are refused. A release with this code
needs `0002_ops_flags.sql` applied (`run_migrations`); without it every call is
refused.

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
