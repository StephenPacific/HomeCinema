#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"

if command -v node >/dev/null 2>&1; then
  homecinema_node="$(command -v node)"
elif [[ -x /opt/homebrew/bin/node ]]; then
  homecinema_node=/opt/homebrew/bin/node
elif [[ -x /usr/local/bin/node ]]; then
  homecinema_node=/usr/local/bin/node
else
  print -u2 'HomeCinema needs Node.js 22.12 or newer. Install Node.js, then run this file again.'
  exit 1
fi

exec "$homecinema_node" scripts/start-release.mjs
