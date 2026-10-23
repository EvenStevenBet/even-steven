#!/usr/bin/env bash
# Runs probe.mjs with a Bankr API key you type in. The key is read silently, never echoed,
# never written to disk, passed only into the single `node probe.mjs` process, and unset on exit.
# Extra arguments go to probe.mjs (for example: ./run.sh --market 0x...).
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

cleanup() { unset key BANKR_API_KEY; }
trap cleanup EXIT

if ! command -v node >/dev/null 2>&1; then
  echo "node was not found. Install Node 20 or newer: https://nodejs.org" >&2; exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${major:-0}" -lt 20 ]; then
  echo "Node 20 or newer is required (found $(node -v 2>/dev/null || echo none))." >&2; exit 1
fi
if [ ! -d node_modules ]; then
  echo "node_modules is missing. Run 'npm install' in $(pwd) first." >&2; exit 1
fi

printf 'Paste your Bankr API key (input is hidden), then press Enter: ' >&2
IFS= read -rs key || true
printf '\n' >&2
# trim leading and trailing whitespace (including a stray CR from a paste)
key="${key#"${key%%[![:space:]]*}"}"
key="${key%"${key##*[![:space:]]}"}"

if [ -z "$key" ]; then echo "No key entered." >&2; exit 1; fi
if [[ "$key" == bk_* ]]; then prefix="yes"; else prefix="NO"; fi
echo "Key length: ${#key}   starts with bk_: ${prefix}" >&2
if [ "$prefix" = "NO" ]; then
  echo "That does not look like a Bankr key (they start with bk_). Stopping." >&2; exit 1
fi

# The assignment prefix scopes the variable to this one command; it is not exported to the shell.
BANKR_API_KEY="$key" node probe.mjs "$@"
