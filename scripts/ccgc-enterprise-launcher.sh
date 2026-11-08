#!/bin/sh
set -eu

PROGRAM=${0##*/}
REPOSITORY_NAME=claude-code-with-github-copilot
ENTRYPOINT_RELATIVE=src/enterprise-cli.ts

fail() {
  printf '%s: %s\n' "$PROGRAM" "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

is_supported_node() {
  [ -x "$1" ] && [ "$(node_major "$1")" = 24 ]
}

resolve_node() {
  if [ -n "${CCGC_NODE:-}" ]; then
    [ -x "$CCGC_NODE" ] || fail "CCGC_NODE is not executable: $CCGC_NODE"
    is_supported_node "$CCGC_NODE" ||
      fail "CCGC_NODE must be Node.js 24.x; found $("$CCGC_NODE" --version 2>/dev/null || printf unknown)."
    printf '%s\n' "$CCGC_NODE"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    candidate=$(command -v node)
    if is_supported_node "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  fi

  candidate=
  for path in \
    "$HOME"/.nvm/versions/node/v24*/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.local/share/fnm/node-versions/v24*/installation/bin/node \
    /opt/homebrew/opt/node@24/bin/node \
    /usr/local/opt/node@24/bin/node
  do
    if is_supported_node "$path"; then
      candidate=$path
    fi
  done
  [ -n "$candidate" ] ||
    fail "Node.js 24.x was not found. Install Node 24 or set CCGC_NODE to its executable."
  printf '%s\n' "$candidate"
}

is_repository_root() {
  [ -f "$1/$ENTRYPOINT_RELATIVE" ] && [ -f "$1/package.json" ]
}

resolve_root() {
  if [ -n "${CCGC_ENTERPRISE_ROOT:-}" ]; then
    is_repository_root "$CCGC_ENTERPRISE_ROOT" ||
      fail "CCGC_ENTERPRISE_ROOT does not contain $ENTRYPOINT_RELATIVE: $CCGC_ENTERPRISE_ROOT"
    (unset CDPATH; cd -- "$CCGC_ENTERPRISE_ROOT" && pwd -P)
    return
  fi

  script_dir=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd -P)
  current_dir=$(pwd -P)
  for path in \
    "$script_dir" \
    "$script_dir/.." \
    "$script_dir/$REPOSITORY_NAME" \
    "$script_dir/../$REPOSITORY_NAME" \
    "$current_dir" \
    "$HOME/$REPOSITORY_NAME" \
    "$HOME/Downloads/$REPOSITORY_NAME" \
    "$HOME/Desktop/$REPOSITORY_NAME" \
    "$HOME/Documents/$REPOSITORY_NAME" \
    "$HOME/Projects/$REPOSITORY_NAME" \
    "$HOME/src/$REPOSITORY_NAME" \
    "$HOME"/Library/CloudStorage/OneDrive-*/Desktop/*/"$REPOSITORY_NAME" \
    "$HOME"/Library/CloudStorage/OneDrive-*/Documents/*/"$REPOSITORY_NAME"
  do
    if is_repository_root "$path"; then
      (unset CDPATH; cd -- "$path" && pwd -P)
      return
    fi
  done

  fail "Could not locate $REPOSITORY_NAME. Put it beside this script or set CCGC_ENTERPRISE_ROOT."
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null || printf unknown
}

show_wrapper_help() {
  cat <<EOF
$PROGRAM - relocatable launcher for the CCGC enterprise client

Usage:
  $PROGRAM <enterprise command> [options]
  $PROGRAM doctor
  $PROGRAM paths
  $PROGRAM wrapper-help

Enterprise commands are forwarded unchanged:
  setup --gateway URL [--apply] [--no-browser]
        [--use-key | --api-key-file YOUR_PRIVATE_JSON] [--credential NAME]
  login --gateway URL --audience AUDIENCE
  login-api-key --gateway URL --api-key-file PRIVATE_JSON
  login-litellm-key --gateway URL --api-key-file PRIVATE_JSON
  configure [--apply]
  desktop-config
  token
  models

Environment overrides:
  CCGC_ENTERPRISE_ROOT       Repository root containing $ENTRYPOINT_RELATIVE
  CCGC_NODE                  Node.js 24.x executable
  CCGC_ENTERPRISE_ENTRYPOINT Alternative executable or TypeScript entrypoint

Security:
  setup signs in to your own LiteLLM user and discovers GitHub identity via OAuth.
  Complete your personal LiteLLM invitation before setup; shared admin login is rejected.
  Existing cached keys are never reused by setup. Older unverified profiles must sign in again.
  API key files should be mode 600 and must not be passed as literal arguments.
  The token command prints a credential and should only be used as apiKeyHelper.
  No daemon is required; this launcher starts the helper only when requested.
  The current credential-store implementation requires macOS Keychain.

Desktop:
  setup writes a secret-free import file under ~/.local/share/ccgc/enterprise/.
  desktop-config prints secret-free JSON for Desktop's third-party config import.
  CLI settings and this wrapper's doctor do not verify Desktop routing.
EOF
}

resolve_runtime() {
  ROOT=$(resolve_root)
  ENTRYPOINT=${CCGC_ENTERPRISE_ENTRYPOINT:-"$ROOT/$ENTRYPOINT_RELATIVE"}
  [ -f "$ENTRYPOINT" ] || fail "Enterprise entrypoint does not exist: $ENTRYPOINT"

  case "$ENTRYPOINT" in
    *.ts|*.js|*.mjs|*.cjs)
      NODE=$(resolve_node)
      [ -d "$ROOT/node_modules" ] ||
        fail "Repository dependencies are missing. Run 'npm ci' in $ROOT."
      ;;
    *)
      [ -x "$ENTRYPOINT" ] || fail "Enterprise entrypoint is not executable: $ENTRYPOINT"
      NODE=
      ;;
  esac
}

run_helper() {
  if [ -n "$NODE" ]; then
    "$NODE" "$ENTRYPOINT" "$@"
  else
    "$ENTRYPOINT" "$@"
  fi
}

doctor() {
  resolve_runtime
  if [ "$(uname -s 2>/dev/null || true)" != Darwin ]; then
    fail "The current enterprise client requires macOS Keychain and is not supported on this operating system."
  fi
  note "Repository: $ROOT"
  note "Entrypoint: $ENTRYPOINT"
  if [ -n "$NODE" ]; then
    note "Runtime: $NODE ($("$NODE" --version))"
  else
    note "Runtime: native executable"
  fi

  if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    note "Revision: $(git -C "$ROOT" rev-parse --short HEAD)"
    if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
      note "Warning: repository has uncommitted changes."
    fi
  fi

  settings="$HOME/.claude/settings.json"
  state="$HOME/.local/share/ccgc/enterprise"
  if [ -f "$settings" ]; then
    mode=$(file_mode "$settings")
    note "Claude settings: $settings (mode $mode)"
    [ "$mode" = 600 ] || note "Warning: Claude settings should normally be mode 600."
  else
    note "Warning: Claude settings are missing; run '$PROGRAM configure --apply' after login."
  fi
  if [ -d "$state" ]; then
    mode=$(file_mode "$state")
    note "Enterprise state: $state (mode $mode)"
    [ "$mode" = 700 ] || note "Warning: enterprise state should normally be mode 700."
  else
    note "Warning: enterprise state is missing; log in before configuring Claude Code."
  fi

  if command -v claude >/dev/null 2>&1; then
    note "Claude Code: $(command -v claude) ($(claude --version 2>/dev/null || printf unknown))"
    count=$(which -a claude 2>/dev/null | awk '!seen[$0]++ { count++ } END { print count+0 }')
    [ "$count" -le 1 ] || note "Warning: multiple Claude Code installations are visible on PATH."
  else
    note "Warning: Claude Code is not available on PATH."
  fi

  note "Checking routing conflicts and settings compatibility..."
  run_helper configure >/dev/null
  note "Checking credential, gateway connectivity, and model policy..."
  run_helper models
  note "CLI doctor completed successfully. Desktop requires its separate gateway configuration and a live GUI check."
}

command=${1:-wrapper-help}
case "$command" in
  wrapper-help)
    show_wrapper_help
    ;;
  doctor)
    [ "$#" -eq 1 ] || fail "doctor does not accept additional arguments."
    doctor
    ;;
  paths)
    [ "$#" -eq 1 ] || fail "paths does not accept additional arguments."
    resolve_runtime
    note "CCGC_ENTERPRISE_ROOT=$ROOT"
    note "CCGC_ENTERPRISE_ENTRYPOINT=$ENTRYPOINT"
    [ -z "$NODE" ] || note "CCGC_NODE=$NODE"
    ;;
  *)
    resolve_runtime
    run_helper "$@"
    ;;
esac
