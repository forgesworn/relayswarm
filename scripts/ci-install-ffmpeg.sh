#!/usr/bin/env bash
# Installs ffmpeg on GitHub's Ubuntu runners. A stalled apt mirror used to hang
# this step until the job limit, so each attempt is time-boxed and retried.
set -euo pipefail

apt_options=(-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=3)

run_phase() {
  local attempt="$1" phase="$2" phase_status
  shift 2
  echo "ffmpeg install attempt ${attempt} phase=${phase} start" >&2
  if "$@"; then
    phase_status=0
  else
    phase_status=$?
  fi
  echo "ffmpeg install attempt ${attempt} phase=${phase} exit_status=${phase_status}" >&2
  return "$phase_status"
}

for attempt in 1 2 3; do
  if run_phase "$attempt" update timeout 120 sudo apt-get "${apt_options[@]}" update -qq &&
    run_phase "$attempt" install timeout 120 sudo DEBIAN_FRONTEND=noninteractive apt-get "${apt_options[@]}" install -y -qq --no-install-recommends ffmpeg; then
    run_phase "$attempt" version ffmpeg -hide_banner -version
    exit 0
  fi
  echo "ffmpeg install attempt ${attempt} failed or timed out" >&2
  sleep 5
done

exit 1
