#!/usr/bin/env bash
set -euo pipefail
umask 077

project="" confirmation="" env_file="" input="" replace=false
compose_files=()
while (($#)); do
  case "$1" in
    --project) project="${2:?Missing project}"; shift 2 ;;
    --confirm-project) confirmation="${2:?Missing confirmation}"; shift 2 ;;
    --compose-file) compose_files+=("${2:?Missing Compose overlay}"); shift 2 ;;
    --env-file) env_file="${2:?Missing environment file}"; shift 2 ;;
    --input) input="${2:?Missing input path}"; shift 2 ;;
    --replace) replace=true; shift ;;
    *) echo 'Usage: bash tools/restore.sh --project mill-recovery --confirm-project mill-recovery --env-file recovery.env --input backups/mill.dump [--replace] [--compose-file overlay.yml]' >&2; exit 2 ;;
  esac
done
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]+$ && "$project" == "$confirmation" ]] || { echo 'Supply an explicit project and matching --confirm-project.' >&2; exit 2; }
[[ -f "$env_file" && -s "$input" ]] || { echo 'Environment and backup files must exist.' >&2; exit 2; }
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$(cd "$(dirname "$env_file")" && pwd)/$(basename "$env_file")"
compose=(docker compose --project-name "$project" --env-file "$env_file" --file "$repo_dir/docker-compose.yml" --file "$repo_dir/docker-compose.postgres.yml")
for file in ${compose_files[@]+"${compose_files[@]}"}; do compose+=(--file "$file"); done
"${compose[@]}" exec -T postgres pg_restore --list <"$input" >/dev/null
existing="$("${compose[@]}" exec -T postgres sh -c 'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command="SELECT count(*) FROM pg_tables WHERE schemaname = '\''public'\''"')"
if [[ "$existing" != "0" && "$replace" != "true" ]]; then
  echo "Project $project already has database tables. Make a backup and pass --replace to replace its data." >&2
  exit 2
fi
echo "Stopping Mill in project $project for database restore."
"${compose[@]}" stop api web
"${compose[@]}" exec -T postgres sh -c 'exec pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --clean --if-exists --no-owner --no-acl --exit-on-error --single-transaction' <"$input"
"${compose[@]}" up --detach --wait --wait-timeout 180 api web
echo "Restored project $project. Check /health/ready and sign in to verify your boards."
