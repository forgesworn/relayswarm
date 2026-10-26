#!/usr/bin/env bash
# Installs ffmpeg on GitHub's Ubuntu runners. A stalled apt mirror used to hang
# this step until the job limit, so each attempt is time-boxed and retried.
set -euo pipefail

# The outer loop retries whole attempts. Retrying each failed download inside
# APT can consume the phase deadline before its mirror transport falls back.
apt_options=(-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=0)

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
    run_phase "$attempt" install timeout 120 sudo DEBIAN_FRONTEND=noninteractive apt-get "${apt_options[@]}" install -y --no-install-recommends ffmpeg; then
    run_phase "$attempt" version ffmpeg -hide_banner -version
    exit 0
  fi
  echo "ffmpeg install attempt ${attempt} failed or timed out" >&2
  if [[ "$attempt" == 1 && "${GITHUB_ACTIONS:-}" == true ]]; then
    if ! run_phase "$attempt" mirror-fallback timeout 10 sudo bash \
      "$(dirname "${BASH_SOURCE[0]}")/ci-fallback-apt-mirrors.sh" /etc/apt/apt-mirrors.txt; then
      echo "ffmpeg mirror fallback failed; continuing bounded install attempts" >&2
    fi
  fi
  sleep 5
done

exit 1
