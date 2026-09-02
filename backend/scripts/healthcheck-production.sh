#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
backend_dir="$(cd -- "${script_dir}/.." && pwd -P)"
env_file="${1:-${backend_dir}/.env.production}"

if [[ ! -f "${env_file}" ]]; then
  echo "Production env file not found: ${env_file}" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi

env_value() {
  local key="$1"
  awk -F= -v wanted="${key}" '$1 == wanted { sub(/^[^=]*=/, ""); gsub(/\r$/, ""); print; exit }' "${env_file}"
}

domain="$(env_value SULLYOS_DOMAIN)"
app_token="$(env_value APP_TOKEN)"
base_url="https://${domain}"

curl_with_startup_retry() {
  curl --fail --silent --show-error --retry 10 --retry-delay 2 --retry-connrefused --max-time 20 "$@"
}

homepage="$(curl_with_startup_retry "${base_url}/")"
if [[ "${homepage}" != *'<div id="root">'* ]]; then
  echo "Frontend homepage is missing or invalid at ${base_url}/." >&2
  exit 1
fi

health="$(curl_with_startup_retry "${base_url}/health")"
if [[ "${health}" != *'"ok":true'* ]]; then
  echo "Unexpected health response: ${health}" >&2
  exit 1
fi

curl_with_startup_retry \
  -H "Authorization: Bearer ${app_token}" \
  "${base_url}/v1/model/status" >/dev/null

echo "OK: frontend, HTTPS, API authentication and PostgreSQL health all passed at ${base_url}."
