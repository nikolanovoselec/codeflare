#!/usr/bin/env bash
set -euo pipefail

apt_options=()
if [[ "${RUNNER_ENVIRONMENT:-}" == 'github-hosted' ]]; then
  # Runner images keep Ubuntu packages in their own source file; other
  # preinstalled repositories are unrelated to the sandbox prerequisite.
  if [[ -n "${1:-}" ]]; then
    source_file=$1
  elif [[ -r /etc/apt/sources.list.d/ubuntu.sources ]]; then
    source_file=/etc/apt/sources.list.d/ubuntu.sources
  else
    source_file=/etc/apt/sources.list
  fi
  if ! sudo test -r "$source_file"; then
    echo 'official Ubuntu apt source unavailable' >&2
    exit 1
  fi
  # The runner's mirror+file route prioritizes azure.archive.ubuntu.com.
  # Use its official Ubuntu archive fallback directly, without changing the
  # image's suites, components or signature/keyring policy (including Signed-By).
  source_dir=$(mktemp -d)
  trap 'rm -rf "$source_dir"' EXIT
  source_name=ubuntu.list
  if [[ "$source_file" == *.sources ]]; then source_name=ubuntu.sources; fi
  routed_source="$source_dir/$source_name"
  sudo sed \
    -e 's#mirror+file:/etc/apt/apt-mirrors\.txt\([[:space:]]\|$\)#https://archive.ubuntu.com/ubuntu/\1#g' \
    -e 's#http://azure\.archive\.ubuntu\.com/ubuntu/\([[:space:]]\|$\)#https://archive.ubuntu.com/ubuntu/\1#g' \
    "$source_file" > "$routed_source"
  # apt's unprivileged acquisition user must be able to read the copied source.
  chmod 755 "$source_dir"
  chmod 644 "$routed_source"
  apt_options=(-o "Dir::Etc::sourcelist=$routed_source" -o 'Dir::Etc::sourceparts=-')
fi

sudo apt-get "${apt_options[@]}" update -qq -o APT::Update::Error-Mode=any
sudo apt-get "${apt_options[@]}" install -y --no-install-recommends bubblewrap apparmor
