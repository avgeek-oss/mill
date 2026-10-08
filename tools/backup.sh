#!/usr/bin/env bash
set -euo pipefail
umask 077

project="" env_file="" output=""
compose_files=()
while (($#)); do
  case "$1" in
    --project) project="${2:?Missing project}"; shift 2 ;;
    --compose-file) compose_files+=("${2:?Missing Compose overlay}"); shift 2 ;;
    --env-file) env_file="${2:?Missing environment file}"; shift 2 ;;
    --output) output="${2:?Missing output path}"; shift 2 ;;
    *) echo 'Usage: bash tools/backup.sh --project mill --env-file .env --output backups/mill.dump [--compose-file overlay.yml]' >&2; exit 2 ;;
  esac
done
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]+$ ]] || { echo 'Supply an explicit Compose project name.' >&2; exit 2; }
[[ -f "$env_file" && -n "$output" && ! -e "$output" ]] || { echo 'Environment file must exist and output must be a new path.' >&2; exit 2; }
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$(cd "$(dirname "$env_file")" && pwd)/$(basename "$env_file")"
mkdir -p "$(dirname "$output")"
partial="$(mktemp "${output}.partial.XXXXXX")"
trap 'rm -f "$partial"' EXIT
compose=(docker compose --project-name "$project" --env-file "$env_file" --file "$repo_dir/docker-compose.yml" --file "$repo_dir/docker-compose.postgres.yml")
for file in ${compose_files[@]+"${compose_files[@]}"}; do compose+=(--file "$file"); done
"${compose[@]}" exec -T postgres \
  sh -c 'exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom --no-owner --no-acl' >"$partial"
[[ -s "$partial" ]] || { echo 'Backup was empty.' >&2; exit 1; }
mv "$partial" "$output"
echo "Backed up Compose project $project to $output. This file includes private account and credential data."
