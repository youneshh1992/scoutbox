#!/bin/zsh
set -eu
project_dir="${0:A:h}"
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
    if [[ -x "$candidate" ]]; then node_bin="$candidate"; break; fi
  done
fi
if [[ -z "$node_bin" ]]; then
  print 'Node.js is needed for this shortcut. Open Claude Desktop → Code and select this ScoutBox folder instead.'
  read '?Press Return to close.'
  exit 1
fi
exec "$node_bin" "$project_dir/scripts/open-claude.mjs" "$@"
