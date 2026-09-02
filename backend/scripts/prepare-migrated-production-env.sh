#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: bash scripts/prepare-migrated-production-env.sh DOMAIN TLS_EMAIL ALLOWED_ORIGINS OLD_VAULT_KEY_FILE" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
backend_dir="$(cd -- "${script_dir}/.." && pwd -P)"
target="${backend_dir}/.env.production"
domain="$1"
email="$2"
origins="$3"
old_key_file="$(realpath -- "$4")"

if [[ -e "${target}" ]]; then
  echo "Refusing to overwrite existing file: ${target}" >&2
  exit 1
fi
if [[ ! -s "${old_key_file}" ]]; then
  echo "Old model vault key file is missing or empty." >&2
  exit 1
fi

bash "${script_dir}/generate-production-env.sh" "${target}"
vault_key="$(tr -d '\r\n' < "${old_key_file}")"
if [[ ${#vault_key} -lt 12 ]]; then
  echo "Old model vault key is invalid." >&2
  exit 1
fi

replace_value() {
  local name="$1"
  local value="$2"
  local escaped="${value//|/\\|}"
  sed -i "s|^${name}=.*|${name}=${escaped}|" "${target}"
}

replace_value SULLYOS_DOMAIN "${domain}"
replace_value SULLYOS_TLS_EMAIL "${email}"
replace_value ALLOWED_ORIGINS "${origins}"
replace_value MODEL_VAULT_KEY "${vault_key}"
chmod 600 "${target}"

echo "Prepared production environment while preserving the existing encrypted model profile."
