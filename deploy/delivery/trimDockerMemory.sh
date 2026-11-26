#!/bin/bash
set -euo pipefail

# Older worker bundles request 1 GiB. Keep their Docker arguments intact
# except for the memory limit of the identified trim sandbox.
if [[ ${1:-} == create ]]; then
  args=("$@")
  memoryIndex=
  trimSandbox=false
  for ((index = 1; index < ${#args[@]}; index++)); do
    case ${args[index]} in
      --label)
        if [[ ${args[index + 1]:-} == com.zenithjoy.trim.protocol=2 ]]; then
          trimSandbox=true
        fi
        ;;
      --memory=1g) memoryIndex=$index ;;
    esac
  done
  if [[ $trimSandbox == true && -n $memoryIndex ]]; then
    args[memoryIndex]=--memory=2g
    exec /usr/bin/docker "${args[@]}"
  fi
fi

exec /usr/bin/docker "$@"
