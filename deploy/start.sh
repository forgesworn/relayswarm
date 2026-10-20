#!/bin/sh
set -eu
set -f
umask 077
: "${PUBLIC_URL:?Set PUBLIC_URL to the existing reverse proxy HTTPS origin}"
# Values become individual arguments; no eval or shell expansion of their contents.
set -- node scripts/broadcast.mjs --input rtsp://router:8554/live --state-dir /state --host 0.0.0.0 --port 8787 --public-url "$PUBLIC_URL" "$@"
if [ -n "${RELAYS:-}" ]; then
  previous_ifs=$IFS
  IFS=,
  for relay in $RELAYS; do set -- "$@" --relay "$relay"; done
  IFS=$previous_ifs
fi
if [ -n "${STUN_URL:-}" ]; then set -- "$@" --stun "$STUN_URL"; fi
case "${ACCOUNT_BUDGET_ENABLED:-0}" in
  1) set -- "$@" --account-budget ;;
  0) ;;
  *) printf '%s\n' 'ACCOUNT_BUDGET_ENABLED must be 0 or 1.' >&2; exit 64 ;;
esac
exec "$@"
