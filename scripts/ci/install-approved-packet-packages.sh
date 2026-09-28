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
  apt_options=(-o "Dir::Etc::sourcelist=$source_file" -o 'Dir::Etc::sourceparts=-')
fi

sudo apt-get "${apt_options[@]}" update -qq -o APT::Update::Error-Mode=any
sudo apt-get "${apt_options[@]}" install -y --no-install-recommends bubblewrap apparmor
