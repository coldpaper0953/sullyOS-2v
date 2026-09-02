#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
backend_dir="$(cd -- "${script_dir}/.." && pwd -P)"
template="${backend_dir}/.env.production.example"
target="${1:-${backend_dir}/.env.production}"

if [[ -e "${target}" ]]; then
  echo "Refusing to overwrite existing file: ${target}" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate production secrets." >&2
  exit 1
fi

postgres_password="$(openssl rand -hex 32)"
app_token="$(openssl rand -hex 32)"
model_vault_key="$(openssl rand -hex 32)"

sed \
  -e "s/REPLACE_WITH_RANDOM_POSTGRES_PASSWORD/${postgres_password}/" \
  -e "s/REPLACE_WITH_RANDOM_APP_TOKEN/${app_token}/" \
  -e "s/REPLACE_WITH_RANDOM_MODEL_VAULT_KEY/${model_vault_key}/" \
  "${template}" > "${target}"
chmod 600 "${target}"

echo "Created ${target} with random secrets."
echo "Next: edit SULLYOS_DOMAIN, SULLYOS_TLS_EMAIL and ALLOWED_ORIGINS."
echo "If restoring the current database, also preserve the old MODEL_VAULT_KEY as documented in the file."
