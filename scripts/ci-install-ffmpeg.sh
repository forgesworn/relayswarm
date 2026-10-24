#!/usr/bin/env bash
# Installs ffmpeg on GitHub's Ubuntu runners. A stalled apt mirror used to hang
# this step until the job limit, so each attempt is time-boxed and retried.
set -euo pipefail

apt_options=(-o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o Acquire::Retries=3)

for attempt in 1 2 3; do
  if timeout 120 sudo apt-get "${apt_options[@]}" update -qq &&
    timeout 120 sudo DEBIAN_FRONTEND=noninteractive apt-get "${apt_options[@]}" install -y -qq --no-install-recommends ffmpeg; then
    ffmpeg -hide_banner -version | head -1
    exit 0
  fi
  echo "ffmpeg install attempt ${attempt} failed or timed out" >&2
  sleep 5
done

exit 1
