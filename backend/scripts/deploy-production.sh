#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
backend_dir="$(cd -- "${script_dir}/.." && pwd -P)"
env_file="${1:-${backend_dir}/.env.production}"
compose_file="${backend_dir}/compose.production.yaml"
frontend_dir="$(cd -- "${backend_dir}/.." && pwd -P)/sullyos-frontend"

if [[ ! -f "${env_file}" ]]; then
  echo "Production env file not found: ${env_file}" >&2
  echo "Run: bash scripts/generate-production-env.sh" >&2
  exit 1
fi
if [[ ! -f "${frontend_dir}/index.html" ]]; then
  echo "Production frontend is missing: ${frontend_dir}/index.html" >&2
  echo "Deploy from the repository root with scripts/deploy-goldenbite-from-git.sh." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Docker Engine with the Compose plugin is required." >&2
  exit 1
fi

env_value() {
  local key="$1"
  awk -F= -v wanted="${key}" '$1 == wanted { sub(/^[^=]*=/, ""); gsub(/\r$/, ""); print; exit }' "${env_file}"
}

domain="$(env_value SULLYOS_DOMAIN)"
email="$(env_value SULLYOS_TLS_EMAIL)"
origins="$(env_value ALLOWED_ORIGINS)"
app_token="$(env_value APP_TOKEN)"
postgres_password="$(env_value POSTGRES_PASSWORD)"
vault_key="$(env_value MODEL_VAULT_KEY)"

if [[ -z "${domain}" || "${domain}" == *example.com* || "${domain}" == *://* || "${domain}" == */* ]]; then
  echo "Set SULLYOS_DOMAIN to a real DNS hostname without scheme or path." >&2
  exit 1
fi
if [[ -z "${email}" || "${email}" == *example.com* || "${email}" != *@* ]]; then
  echo "Set SULLYOS_TLS_EMAIL to a real certificate contact email." >&2
  exit 1
fi
if [[ -z "${origins}" || "${origins}" == *example.com* || "${origins}" == *"*"* ]]; then
  echo "Set ALLOWED_ORIGINS to the exact frontend origins; wildcards are not allowed." >&2
  exit 1
fi
for secret_name in app_token postgres_password; do
  secret_value="${!secret_name}"
  if [[ ${#secret_value} -lt 32 || "${secret_value}" == *REPLACE_WITH* ]]; then
    echo "${secret_name} must be a non-placeholder secret of at least 32 characters." >&2
    exit 1
  fi
done
if [[ ${#vault_key} -lt 12 || "${vault_key}" == *REPLACE_WITH* ]]; then
  echo "vault_key must preserve the existing local vault secret and contain at least 12 characters." >&2
  exit 1
fi
if [[ ${#vault_key} -lt 32 ]]; then
  echo "Warning: preserving a legacy MODEL_VAULT_KEY shorter than 32 characters for encrypted model compatibility." >&2
fi

compose=(docker compose --env-file "${env_file}" -f "${compose_file}")
"${compose[@]}" config --quiet

# A production deployment deliberately leaves autonomous wakeups off. Re-enable
# the heartbeat profile only after API/chat/sync verification is complete.
"${compose[@]}" --profile heartbeat stop worker >/dev/null 2>&1 || true
"${compose[@]}" up -d --build --remove-orphans
"${compose[@]}" ps

echo
echo "Deployment started. After DNS reaches this VPS, verify with:"
echo "  bash scripts/healthcheck-production.sh ${env_file}"
echo "Worker is stopped. Do not enable it until the initial VPS checklist passes."
