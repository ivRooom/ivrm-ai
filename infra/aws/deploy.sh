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

prepare_runtime_env() {
  local database_url kill_switch tmp
  database_url="$(load_required_parameter "$DATABASE_URL_PARAMETER")"
  case "$database_url" in
    postgres://* | postgresql://*) ;;
    *)
      echo "database URL must start with postgres:// or postgresql://" >&2
      return 1
      ;;
  esac

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
  docker run --rm --env-file "$ENV_FILE" --memory 256m "$IVRM_AI_IMAGE" \
    node dist/db/migrate-cli.js
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
