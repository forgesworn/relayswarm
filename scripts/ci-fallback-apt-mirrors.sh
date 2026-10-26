#!/usr/bin/env bash
# Remove the runner's Azure mirror only when this same list already offers an
# official Ubuntu archive/security alternative. Never edit APT source settings.
set -euo pipefail

if [[ "$#" != 1 ]]; then
  echo "usage: ci-fallback-apt-mirrors.sh MIRROR_LIST" >&2
  exit 64
fi
mirror_list="$1"
[[ "$mirror_list" == /* ]] || mirror_list="$PWD/$mirror_list"
if [[ ! -f "$mirror_list" || -L "$mirror_list" || ! -r "$mirror_list" ]]; then
  echo "ffmpeg mirror fallback unchanged reason=no-regular-readable-list" >&2
  exit 0
fi

azure='^https?://azure\.archive\.ubuntu\.com(:80|:443)?/ubuntu/?$'
official='^https?://(archive|security)\.ubuntu\.com(:80|:443)?/ubuntu/?$'
lines=() endings=() urls=()
azure_count=0
has_alternative=false
while true; do
  if IFS= read -r line; then
    ending=$'\n'
  else
    ending=''
    [[ -n "$line" ]] || break
  fi
  IFS=$' \t\r' read -r url metadata <<< "$line"
  lines+=("$line") endings+=("$ending") urls+=("$url")
  if [[ "$url" =~ $azure ]]; then
    azure_count=$((azure_count + 1))
  elif [[ "$url" =~ $official ]]; then
    has_alternative=true
  fi
done < "$mirror_list"
if [[ "$azure_count" == 0 || "$has_alternative" != true ]]; then
  echo "ffmpeg mirror fallback unchanged azure_entries=${azure_count} official_alternative=${has_alternative}" >&2
  exit 0
fi

temporary=$(mktemp "${mirror_list}.fallback.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
# Preserve permissions/ownership and all bytes of the remaining lines, including
# their priority metadata, CRLFs and any final line without a newline.
cp -p "$mirror_list" "$temporary"
{
  for ((i = 0; i < ${#lines[@]}; i++)); do
    [[ "${urls[i]}" =~ $azure ]] || printf '%s%s' "${lines[i]}" "${endings[i]}"
  done
} > "$temporary"
mv -f "$temporary" "$mirror_list"
echo "ffmpeg mirror fallback changed removed_azure_entries=${azure_count}" >&2
