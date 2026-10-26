#!/usr/bin/env bash
# Deploys ivrm-ai on the production instance (run through SSM by the deploy
# workflow). Mirrors ivrm-web's infra/aws/api/deploy.sh: lock, pull, recreate,
# health check, roll back to the previous image on failure.
set -Eeuo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${ECR_REGISTRY:?ECR_REGISTRY is required}"
: "${IVRM_AI_IMAGE:?IVRM_AI_IMAGE is required}"
# "true" applies the SQL migrations before the new container starts. Anything
# else leaves the schema untouched. Migrations change the production database,
# so the workflow only passes "true" when the operator asked for it.
RUN_MIGRATIONS="${RUN_MIGRATIONS:-false}"

APP_DIR="/opt/ivrm/ai"
COMPOSE_FILE="$APP_DIR/docker-compose.yml"
ENV_FILE="$APP_DIR/runtime.env"
LOCK_FILE="/var/lock/ivrm-ai-deploy.lock"
CURRENT_IMAGE_FILE="$APP_DIR/current-image"
DATABASE_URL_PARAMETER="${DATABASE_URL_PARAMETER:-/ivrm/ai/database-url}"
# Migrations run as the migrator role (DDL); the app gets the runtime role only.
DATABASE_MIGRATION_URL_PARAMETER="${DATABASE_MIGRATION_URL_PARAMETER:-/ivrm/ai/database-migration-url}"
# CA of the database server certificate (public). The URLs point sslrootcert at
# /etc/ivrm-ai/db-ca.crt, where the compose file and the migration run mount it.
DATABASE_CA_PARAMETER="${DATABASE_CA_PARAMETER:-/ivrm/ai/database-ca-cert}"
CA_FILE="$APP_DIR/db-ca.crt"
MIGRATE_ENV_FILE="$APP_DIR/migrate.env"
KILL_SWITCH_PARAMETER="${KILL_SWITCH_PARAMETER:-/ivrm/ai/kill-switch}"

mkdir -p "$APP_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "another ivrm-ai deployment is already running" >&2
  exit 1
}

previous_image="$(docker inspect --format '{{.Config.Image}}' ivrm-ai 2>/dev/null || true)"
rollback_enabled=0

# Required: a missing database URL stops the deployment.
load_required_parameter() {
  local value
  value="$(aws ssm get-parameter --region "$AWS_REGION" --name "$1" \
    --with-decryption --query 'Parameter.Value' --output text)"
  test -n "$value"
  printf '%s' "$value"
}

# Optional flag: only a missing parameter means "off". Any other failure
# (AccessDenied, throttling) fails the deployment, so a configured kill switch
# can never silently turn itself off.
load_flag_parameter() {
  local value error_file
  error_file="$(mktemp)"
  if value="$(aws ssm get-parameter --region "$AWS_REGION" --name "$1" \
    --with-decryption --query 'Parameter.Value' --output text 2> "$error_file")"; then
    :
  elif grep -q "ParameterNotFound" "$error_file"; then
    value=""
  else
    echo "failed to read parameter: $1" >&2
    cat "$error_file" >&2 || true
    rm -f "$error_file"
    return 1
  fi
  rm -f "$error_file"
  [ "$value" = "None" ] && value=""
  printf '%s' "$value"
}

# A database URL must be postgres:// and verify the server certificate against
# the mounted CA. The query is checked parameter by parameter (a substring
# match would accept e.g. application_name=sslmode=verify-full).
check_database_url() {
  local query param sslmode="" sslrootcert="" sslmode_count=0 sslrootcert_count=0
  case "$2" in
    postgres://* | postgresql://*) ;;
    *)
      echo "$1 must start with postgres:// or postgresql://" >&2
      return 1
      ;;
  esac
  case "$2" in
    *\?*) query="${2#*\?}" ;;
    *) query="" ;;
  esac
  local IFS='&'
  for param in $query; do
    case "$param" in
      sslmode=*)
        sslmode_count=$((sslmode_count + 1))
        sslmode="${param#sslmode=}"
        ;;
      sslrootcert=*)
        sslrootcert_count=$((sslrootcert_count + 1))
        sslrootcert="${param#sslrootcert=}"
        ;;
      ssl=* | sslcert=* | sslkey=* | uselibpqcompat=*)
        echo "$1 must not set ${param%%=*}" >&2
        return 1
        ;;
    esac
  done
  if [ "$sslmode_count" -ne 1 ] || [ "$sslmode" != "verify-full" ]; then
    echo "$1 must use sslmode=verify-full exactly once" >&2
    return 1
  fi
  if [ "$sslrootcert_count" -ne 1 ] || [ "$sslrootcert" != "/etc/ivrm-ai/db-ca.crt" ]; then
    echo "$1 must set sslrootcert=/etc/ivrm-ai/db-ca.crt exactly once" >&2
    return 1
  fi
}

prepare_database_ca() {
  local ca tmp
  ca="$(load_required_parameter "$DATABASE_CA_PARAMETER")"
  case "$ca" in
    "-----BEGIN CERTIFICATE-----"*) ;;
    *)
      echo "database CA parameter is not a PEM certificate" >&2
      return 1
      ;;
  esac
  tmp="$CA_FILE.tmp"
  printf '%s\n' "$ca" > "$tmp"
  # Keep the previous CA unless the new one parses as a certificate.
  if ! openssl x509 -in "$tmp" -noout 2> /dev/null; then
    rm -f "$tmp"
    echo "database CA parameter is not a valid certificate" >&2
    return 1
  fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$CA_FILE"
}

prepare_migration_env() {
  local migration_url
  migration_url="$(load_required_parameter "$DATABASE_MIGRATION_URL_PARAMETER")"
  check_database_url "database migration URL" "$migration_url"
  umask 077
  printf 'DATABASE_MIGRATION_URL=%s\n' "$migration_url" > "$MIGRATE_ENV_FILE"
  chmod 0600 "$MIGRATE_ENV_FILE"
  unset migration_url
}

prepare_runtime_env() {
  local database_url kill_switch tmp
  database_url="$(load_required_parameter "$DATABASE_URL_PARAMETER")"
  check_database_url "database URL" "$database_url"

  kill_switch="$(load_flag_parameter "$KILL_SWITCH_PARAMETER")"
  if [ "$kill_switch" = "true" ]; then
    echo "kill switch: ON (every model call is refused)"
  else
    kill_switch="false"
    echo "kill switch: off"
  fi

  umask 077
  tmp="$ENV_FILE.tmp"
  {
    printf 'DATABASE_URL=%s\n' "$database_url"
    printf 'AI_KILL_SWITCH=%s\n' "$kill_switch"
  } > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
  unset database_url
}

wait_for_healthy() {
  local attempts="${1:-20}" status
  for _ in $(seq 1 "$attempts"); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ivrm-ai 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    [[ "$status" == "unhealthy" || "$status" == "exited" || "$status" == "dead" ]] && return 1
    sleep 6
  done
  return 1
}

assert_local_http_status() {
  local expected="$1" path="$2" actual
  actual="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --max-time 10 "http://127.0.0.1:3100${path}" || true)"
  if [[ "$actual" != "$expected" ]]; then
    echo "unexpected status for ${path}: expected=${expected} actual=${actual:-000}" >&2
    return 1
  fi
}

rollback() {
  local exit_code=$?
  rm -f "$MIGRATE_ENV_FILE"
  if [[ "$exit_code" -ne 0 ]]; then
    echo "ivrm-ai deployment failed: $IVRM_AI_IMAGE" >&2
    docker ps -a --filter name=ivrm-ai || true
    docker logs --tail 200 ivrm-ai || true
    if [[ "$rollback_enabled" -eq 1 && -n "$previous_image" ]]; then
      echo "rolling back ivrm-ai to: $previous_image" >&2
      export IVRM_AI_IMAGE="$previous_image"
      docker compose -f "$COMPOSE_FILE" up -d --force-recreate --remove-orphans || true
      if wait_for_healthy 10; then
        printf '%s\n' "$previous_image" > "$CURRENT_IMAGE_FILE"
        echo "ivrm-ai rollback completed" >&2
      else
        echo "ivrm-ai rollback did not become healthy" >&2
        docker logs --tail 200 ivrm-ai || true
      fi
    fi
  fi
  exit "$exit_code"
}
trap rollback EXIT

prepare_database_ca
prepare_runtime_env

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"
docker pull "$IVRM_AI_IMAGE"
docker logout "$ECR_REGISTRY" >/dev/null 2>&1 || true

if [[ -n "$previous_image" && "$previous_image" != "$IVRM_AI_IMAGE" ]]; then
  rollback_enabled=1
fi

if [[ "$RUN_MIGRATIONS" == "true" ]]; then
  echo "applying migrations"
  prepare_migration_env
  docker run --rm --env-file "$MIGRATE_ENV_FILE" --memory 256m \
    -v "$CA_FILE:/etc/ivrm-ai/db-ca.crt:ro" "$IVRM_AI_IMAGE" \
    node dist/db/migrate-cli.js
  rm -f "$MIGRATE_ENV_FILE"
else
  echo "migrations: skipped (RUN_MIGRATIONS is not true)"
fi

export IVRM_AI_IMAGE
docker compose -f "$COMPOSE_FILE" up -d --force-recreate --remove-orphans

if ! wait_for_healthy 20; then
  echo "ivrm-ai did not become healthy in time" >&2
  exit 1
fi

curl --fail --silent --show-error http://127.0.0.1:3100/healthz >/dev/null
# Without a session these must be refused: proves the auth middleware is wired.
assert_local_http_status 401 /api/me
assert_local_http_status 401 /api/models

printf '%s\n' "$IVRM_AI_IMAGE" > "$CURRENT_IMAGE_FILE"
docker image prune -f
rollback_enabled=0
trap - EXIT

echo "=== IVRM AI CONTAINER ==="
docker ps --filter name=ivrm-ai
echo "=== IVRM AI RESOURCES ==="
docker stats --no-stream ivrm-ai || true
free -h || true
df -h / || true
echo "ivrm-ai deployment completed: $IVRM_AI_IMAGE"
