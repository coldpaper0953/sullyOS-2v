#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${1:-}" != "--confirm-restore" || -z "${2:-}" ]]; then
  echo "Destructive operation. Usage:" >&2
  echo "  bash scripts/restore-database.sh --confirm-restore /absolute/path/backup.dump" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
backend_dir="$(cd -- "${script_dir}/.." && pwd -P)"
env_file="${backend_dir}/.env.production"
compose_file="${backend_dir}/compose.production.yaml"
backup_file="$(realpath -- "${2}")"

if [[ ! -f "${backup_file}" || "${backup_file}" != *.dump ]]; then
  echo "Backup must be an existing .dump file: ${backup_file}" >&2
  exit 1
fi
if [[ ! -f "${env_file}" ]]; then
  echo "Production env file not found: ${env_file}" >&2
  exit 1
fi
if [[ -f "${backup_file}.sha256" ]]; then
  (cd -- "$(dirname -- "${backup_file}")" && sha256sum --check "$(basename -- "${backup_file}.sha256")")
else
  echo "Warning: no checksum file found next to the backup." >&2
fi

compose=(docker compose --env-file "${env_file}" -f "${compose_file}")
echo "Creating a recoverable pre-restore backup first..."
bash "${script_dir}/backup-database.sh" --production

# Stop all writers before replacing the database. Worker stays stopped after
# restore and must be explicitly re-enabled after verification.
"${compose[@]}" --profile heartbeat stop worker >/dev/null 2>&1 || true
"${compose[@]}" stop api
"${compose[@]}" exec -T postgres sh -c \
  'exec pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --clean --if-exists --exit-on-error --no-owner --no-privileges' \
  < "${backup_file}"
"${compose[@]}" run --rm migrate
"${compose[@]}" up -d api caddy

echo "Restore completed. Worker remains stopped."
echo "Run: bash scripts/healthcheck-production.sh"
