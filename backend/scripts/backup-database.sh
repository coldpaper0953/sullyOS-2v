#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
backend_dir="$(cd -- "${script_dir}/.." && pwd -P)"
mode="production"
if [[ "${1:-}" == "--local" ]]; then
  mode="local"
elif [[ "${1:-}" == "--production" || -z "${1:-}" ]]; then
  mode="production"
else
  echo "Usage: bash scripts/backup-database.sh [--local|--production]" >&2
  exit 1
fi

if [[ "${mode}" == "local" ]]; then
  env_file="${backend_dir}/.env"
  compose_file="${backend_dir}/compose.yaml"
else
  env_file="${backend_dir}/.env.production"
  compose_file="${backend_dir}/compose.production.yaml"
fi
if [[ ! -f "${env_file}" ]]; then
  echo "Environment file not found: ${env_file}" >&2
  exit 1
fi

backup_dir="${BACKUP_DIR:-${backend_dir}/backups}"
mkdir -p "${backup_dir}"
backup_dir="$(cd -- "${backup_dir}" && pwd -P)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_dir}/sullyos-${mode}-${timestamp}.dump"
partial="${target}.partial"
compose=(docker compose --env-file "${env_file}" -f "${compose_file}")

cleanup_partial() {
  rm -f -- "${partial}"
}
trap cleanup_partial EXIT

"${compose[@]}" exec -T postgres sh -c \
  'exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --compress=9 --no-owner --no-privileges' \
  > "${partial}"
mv -- "${partial}" "${target}"
(cd -- "${backup_dir}" && sha256sum "$(basename -- "${target}")") > "${target}.sha256"
chmod 600 "${target}" "${target}.sha256"
trap - EXIT

echo "Database backup created: ${target}"
echo "Checksum: ${target}.sha256"
