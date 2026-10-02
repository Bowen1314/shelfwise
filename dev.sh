#!/usr/bin/env bash
# One-command local run.
#
#   ./dev.sh            build the UI and serve it in SAMPLE-DATA mode (no keys needed; it uses a real model on the
#                       sample data only if NEBIUS_API_KEY is set, and says which before it starts)
#   ./dev.sh live       build the UI and serve it in live mode (reads .env)
#   ./dev.sh web        Vite dev server for the UI (hot reload) proxying to the API on :8790
#                       (start ./dev.sh in another terminal first)
#
# Node: Shelfwise needs Node >= 22.19. If the `node` on your PATH is older, this script
# puts the first newer Homebrew Node it finds in front of PATH for this process only.
# It never installs, links or changes anything on your machine.
set -euo pipefail
cd "$(dirname "$0")"

MIN_MAJOR=22
MIN_MINOR=19

node_ok() { # $1 = path to node
  local v
  v="$("$1" -p 'process.versions.node' 2>/dev/null)" || return 1
  local major minor
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  [ "$major" -gt "$MIN_MAJOR" ] || { [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -ge "$MIN_MINOR" ]; }
}

if ! command -v node >/dev/null 2>&1 || ! node_ok "$(command -v node)"; then
  for candidate in /opt/homebrew/opt/node@26/bin /opt/homebrew/opt/node@24/bin /opt/homebrew/opt/node@22/bin \
                   /opt/homebrew/opt/node/bin /usr/local/opt/node@24/bin /usr/local/opt/node@22/bin /usr/local/opt/node/bin; do
    if [ -x "$candidate/node" ] && node_ok "$candidate/node"; then
      export PATH="$candidate:$PATH"
      echo "dev.sh: using $("$candidate/node" --version) from $candidate for this run only"
      break
    fi
  done
fi
if ! command -v node >/dev/null 2>&1 || ! node_ok "$(command -v node)"; then
  echo "dev.sh: Node >= ${MIN_MAJOR}.${MIN_MINOR} is required (found: $(node --version 2>/dev/null || echo none))." >&2
  echo "        Put a newer Node first on PATH, then re-run." >&2
  exit 1
fi

[ -d node_modules ] || npm install

# Where the server will find the model key: the environment wins (Node's loadEnvFile never overrides a variable that
# is already set, even to an empty string), otherwise a non-blank value in .env. Prints a place name, never a value.
key_source() {
  if [ "${NEBIUS_API_KEY+set}" = set ]; then
    if [ -n "$(printf '%s' "$NEBIUS_API_KEY" | tr -d '[:space:]')" ]; then echo "the environment"; fi
    return 0
  fi
  if [ -f .env ] && grep -Eq "^[[:space:]]*NEBIUS_API_KEY[[:space:]]*=[[:space:]]*[\"']?[^[:space:]\"'#]" .env; then echo ".env"; fi
  return 0
}

# Shelfwise reads only NEBIUS_API_KEY and SHELFWISE_LLM_*. Say so if the shell holds generic names from other tools.
ignored=""
for name in LLM_API_KEY OPENAI_API_KEY LLM_BASE_URL LLM_MODEL; do
  if [ -n "${!name:-}" ]; then ignored="$ignored $name"; fi
done
if [ -n "$ignored" ]; then
  echo "dev.sh: ignoring variables that belong to other tools:$ignored (Shelfwise reads only NEBIUS_API_KEY and SHELFWISE_LLM_*)"
fi

mode="${1:-sample}"
case "$mode" in
  sample)
    npm run build:web --silent
    echo "dev.sh: SAMPLE-DATA mode (DEMO_FIXTURES=1). Not live Qloo results."
    src="$(key_source)"
    if [ -n "$src" ]; then
      echo "dev.sh: planner: REAL language model. NEBIUS_API_KEY is set (in $src), so the model WILL be called, on sample data."
      echo "        To use the scripted placeholder instead, remove NEBIUS_API_KEY from $src."
    else
      echo "dev.sh: planner: scripted placeholder. NEBIUS_API_KEY is not set, so no model request will be made."
    fi
    DEMO_FIXTURES=1 exec npx tsx src/server/index.ts
    ;;
  live)
    npm run build:web --silent
    echo "dev.sh: LIVE mode. Needs QLOO_API_KEY and NEBIUS_API_KEY in .env or the environment"
    exec npx tsx src/server/index.ts
    ;;
  web)
    exec npm run dev:web
    ;;
  *)
    echo "usage: ./dev.sh [sample|live|web]" >&2
    exit 2
    ;;
esac
