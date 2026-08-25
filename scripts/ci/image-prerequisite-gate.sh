#!/usr/bin/env bash

# Wait for every concurrent image-publication prerequisite and return the first
# failure only after all children settle. This file is sourced by the workflow
# because Bash can wait only for child processes of the current shell.
wait_for_image_prerequisites() {
  if [ "$#" -eq 0 ]; then
    printf '%s\n' 'wait_for_image_prerequisites requires at least one PID' >&2
    return 2
  fi

  local pid result status=0
  for pid in "$@"; do
    if wait "$pid"; then
      continue
    else
      result=$?
      if [ "$status" -eq 0 ]; then
        status=$result
      fi
    fi
  done
  return "$status"
}
