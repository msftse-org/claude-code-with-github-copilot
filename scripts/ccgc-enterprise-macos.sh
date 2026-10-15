#!/bin/bash

set -euo pipefail
umask 077

DEFAULT_GATEWAY='https://ca-ccgc-pilot-broker.bluefield-2d967d14.swedencentral.azurecontainerapps.io'
SUPPORTED_CLAUDE_VERSION='2.1.296'
INSTALL_PATH="$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh"
PROFILE_PATH="$HOME/.local/share/ccgc/enterprise/profile.json"
SETTINGS_PATH="$HOME/.claude/settings.json"
JSON_SETUP_MARKER='__ccgc_setup_719ee977'
TEMP_DIR=''

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup_temp() {
  if [ -z "$TEMP_DIR" ]; then
    return 0
  fi
  /bin/rm -f \
    "$TEMP_DIR/body.json" \
    "$TEMP_DIR/complete.json" \
    "$TEMP_DIR/info.json" \
    "$TEMP_DIR/profile.json" \
    "$TEMP_DIR/response.json" \
    "$TEMP_DIR/settings.json"
  /bin/rmdir "$TEMP_DIR" 2>/dev/null || true
  TEMP_DIR=''
  return 0
}

usage() {
  cat <<'EOF'
CCGC enterprise macOS enrollment

Usage:
  bash ccgc-enterprise-macos.sh enroll --code CCGC-ONE-TIME-CODE
  bash ccgc-enterprise-macos.sh enroll --gateway HTTPS_URL --code CCGC-ONE-TIME-CODE
  bash ccgc-enterprise-macos.sh token
  bash ccgc-enterprise-macos.sh models
  bash ccgc-enterprise-macos.sh configure

The enrollment command verifies the assigned GitHub account, stores the
30-day employee key in macOS Keychain, and configures Claude Code. It does not
disable Gatekeeper, remove quarantine attributes, or change MDM policy.
EOF
}

require_macos_tools() {
  [ "$(uname -s)" = 'Darwin' ] || fail 'this script supports macOS only'
  for tool in /usr/bin/curl /usr/bin/open /usr/bin/plutil /usr/bin/security /usr/bin/shasum; do
    [ -x "$tool" ] || fail "required macOS tool is unavailable: $tool"
  done
}

require_claude_version() {
  local output
  local version
  command -v claude >/dev/null 2>&1 ||
    fail "Claude Code $SUPPORTED_CLAUDE_VERSION is required; install it before enrollment"
  output="$(claude --version 2>/dev/null)" ||
    fail 'could not determine the installed Claude Code version'
  if [[ "$output" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    version="${BASH_REMATCH[1]}"
  else
    fail 'could not parse the installed Claude Code version'
  fi
  [ "$version" = "$SUPPORTED_CLAUDE_VERSION" ] ||
    fail "Claude Code $SUPPORTED_CLAUDE_VERSION is required (found $version); run 'claude install $SUPPORTED_CLAUDE_VERSION'"
}

json_raw() {
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

json_value() {
  local value
  value="$(json_raw "$1" "$2")" || fail "gateway response is missing $2"
  printf '%s' "$value"
}

json_array() {
  /usr/bin/plutil -extract "$2" json -o - "$1" 2>/dev/null
}

valid_json() {
  /usr/bin/plutil -convert json -o /dev/null "$1" >/dev/null 2>&1
}

sha256() {
  /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}'
}

api_key_service() {
  local digest
  digest="$(printf 'enterprise-api-key\n%s' "$1" | sha256)"
  printf 'ccgc.remote.%s' "$digest"
}

admission_service() {
  local digest
  digest="$(printf '%s' "$1" | sha256)"
  printf 'ccgc.remote.%s' "$digest"
}

keychain_get() {
  /usr/bin/security find-generic-password -a owner -s "$1" -w 2>/dev/null
}

keychain_set() {
  printf 'add-generic-password -U -a owner -s %s -w %s\n' "$1" "$2" |
    /usr/bin/security -i >/dev/null
  [ "$(keychain_get "$1")" = "$2" ] || fail 'macOS Keychain did not persist the credential'
}

keychain_delete() {
  /usr/bin/security delete-generic-password -a owner -s "$1" >/dev/null 2>&1 || true
}

write_body() {
  printf '%s\n' "$2" >"$1"
}

request_json() {
  local method="$1"
  local url="$2"
  local bearer="$3"
  local body_file="$4"
  local output_file="$5"
  local code
  local curl_args=(
    --silent
    --show-error
    --max-time 30
    --request "$method"
    --url "$url"
    --header 'Accept: application/json'
    --output "$output_file"
    --write-out '%{http_code}'
  )

  if [ -n "$body_file" ]; then
    curl_args+=(--header 'Content-Type: application/json' --data-binary "@$body_file")
  fi

  if [ -n "$bearer" ]; then
    code="$(printf 'header = "Authorization: Bearer %s"\n' "$bearer" |
      /usr/bin/curl "${curl_args[@]}" --config -)"
  else
    code="$(/usr/bin/curl "${curl_args[@]}")"
  fi
  case "$code" in
    2??) ;;
    *) fail "enterprise gateway returned HTTP $code" ;;
  esac
  valid_json "$output_file" ||
    fail 'enterprise gateway returned invalid JSON'
}

validate_gateway() {
  [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] ||
    fail 'gateway must be an HTTPS origin without credentials, path, query, or fragment'
}

validate_code() {
  [[ "$1" =~ ^CCGC-[A-Za-z0-9_-]{24}$ ]] || fail 'invalid enrollment code'
}

validate_api_key() {
  [[ "$1" =~ ^ccgc_sk_[A-Za-z0-9_-]{43}$ ]] || fail 'gateway returned an invalid employee key'
}

validate_admission() {
  [[ "$1" =~ ^[a-f0-9]{64}$ ]] || fail 'gateway returned an invalid admission'
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | /usr/bin/sed "s/'/'\"'\"'/g")"
}

installed_helper() {
  printf "%s token" "$(shell_quote /bin/bash) $(shell_quote "$INSTALL_PATH")"
}

install_self() {
  local source_path
  source_path="$0"
  [ -f "$source_path" ] || fail 'save this script to a file before running enrollment'
  /bin/mkdir -p "$(dirname "$INSTALL_PATH")"
  if [ "$source_path" != "$INSTALL_PATH" ]; then
    /bin/cp "$source_path" "$INSTALL_PATH"
  fi
  /bin/chmod 0600 "$INSTALL_PATH"
}

client_model() {
  if [ "$1" = 'claude-haiku-4.5' ]; then
    printf 'claude-haiku-4-5-20251001'
  else
    printf '%s' "$1" | /usr/bin/tr '.' '-'
  fi
}

plist_set_string() {
  local file="$1"
  local path="$2"
  local value="$3"
  if /usr/bin/plutil -extract "$path" raw -o - "$file" >/dev/null 2>&1; then
    /usr/bin/plutil -replace "$path" -string "$value" "$file"
  else
    /usr/bin/plutil -insert "$path" -string "$value" "$file"
  fi
}

prepare_settings() {
  local gateway="$1"
  local default_model="$2"
  local output="$3"
  local helper
  local existing
  local key
  local desired
  local permission_mode
  local backup_path
  local choice
  local setting_conflicts=()

  helper="$(installed_helper)"
  if [ -f "$SETTINGS_PATH" ]; then
    valid_json "$SETTINGS_PATH" ||
      fail 'existing Claude settings are not valid JSON'
    /bin/cp "$SETTINGS_PATH" "$output"
    /usr/bin/plutil -convert json "$output"
    if json_raw "$output" "$JSON_SETUP_MARKER" >/dev/null 2>&1; then
      fail 'Claude settings contain a reserved CCGC setup key'
    fi
    if [ "$(/usr/bin/plutil -p "$output")" = '{}' ]; then
      printf '{"%s":"active"}\n' "$JSON_SETUP_MARKER" >"$output"
    else
      /usr/bin/plutil -insert "$JSON_SETUP_MARKER" -string active "$output"
    fi
  else
    printf '{"%s":"active"}\n' "$JSON_SETUP_MARKER" >"$output"
  fi

  if existing="$(json_raw "$output" apiKeyHelper 2>/dev/null)" &&
    [ -n "$existing" ] && [ "$existing" != "$helper" ]; then
    fail 'an unrelated Claude credential helper is already configured'
  fi

  if ! /usr/bin/plutil -extract env json -o - "$output" >/dev/null 2>&1; then
    /usr/bin/plutil -insert env -dictionary "$output"
  fi
  if ! /usr/bin/plutil -extract permissions json -o - "$output" >/dev/null 2>&1; then
    /usr/bin/plutil -insert permissions -dictionary "$output"
  fi

  permission_mode="$(json_raw "$output" permissions.defaultMode 2>/dev/null || true)"

  for key in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
    if [ -n "${!key-}" ]; then
      fail "shell environment setting $key conflicts with the enterprise gateway; run 'unset $key' and retry"
    fi
    if json_raw "$output" "env.$key" >/dev/null 2>&1; then
      setting_conflicts+=("$key")
    fi
  done

  while IFS='=' read -r key desired; do
    existing="${!key-}"
    if [ -n "$existing" ] && [ "$existing" != "$desired" ]; then
      fail "shell environment setting $key conflicts with the enterprise gateway; run 'unset $key' and retry"
    fi
    existing="$(json_raw "$output" "env.$key" 2>/dev/null || true)"
    if [ -n "$existing" ] && [ "$existing" != "$desired" ]; then
      setting_conflicts+=("$key")
    fi
  done <<EOF
ANTHROPIC_BASE_URL=$gateway
ANTHROPIC_DEFAULT_MODEL=$(client_model "$default_model")
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
CLAUDE_CODE_API_KEY_HELPER_TTL_MS=60000
CLAUDE_CODE_AUTO_MODE_SERVER=0
EOF

  if [ "${#setting_conflicts[@]}" -gt 0 ]; then
    printf 'Existing Claude setting(s) conflict with the enterprise gateway:\n' >&2
    for key in "${setting_conflicts[@]}"; do
      printf '  - %s\n' "$key" >&2
    done
    printf '\nChoose an action:\n' >&2
    printf '  1. Back up Claude settings, replace only these enterprise-managed settings, and continue.\n' >&2
    printf '  2. Cancel without changing Claude settings.\n' >&2
    printf 'Enter 1 or 2: ' >&2
    IFS= read -r choice ||
      fail 'interactive confirmation is required to resolve existing Claude credentials'
    case "$choice" in
      1)
        backup_path="$SETTINGS_PATH.ccgc-backup.$(/bin/date -u '+%Y%m%dT%H%M%SZ')"
        [ -f "$SETTINGS_PATH" ] || fail 'Claude settings disappeared before backup'
        /bin/cp -p "$SETTINGS_PATH" "$backup_path"
        /bin/chmod 0600 "$backup_path"
        for key in "${setting_conflicts[@]}"; do
          /usr/bin/plutil -remove "env.$key" "$output"
        done
        printf 'Backed up existing Claude settings to %s\n' "$backup_path" >&2
        ;;
      2)
        fail 'enrollment cancelled; existing Claude settings were not changed'
        ;;
      *)
        fail 'invalid choice; existing Claude settings were not changed'
        ;;
    esac
  fi

  while IFS='=' read -r key desired; do
    plist_set_string "$output" "env.$key" "$desired"
  done <<EOF
ANTHROPIC_BASE_URL=$gateway
ANTHROPIC_DEFAULT_MODEL=$(client_model "$default_model")
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
CLAUDE_CODE_API_KEY_HELPER_TTL_MS=60000
CLAUDE_CODE_AUTO_MODE_SERVER=0
EOF

  if [ -z "$permission_mode" ]; then
    plist_set_string "$output" permissions.defaultMode manual
  fi
  plist_set_string "$output" apiKeyHelper "$helper"
  /usr/bin/plutil -remove "$JSON_SETUP_MARKER" "$output"
  /usr/bin/plutil -convert json "$output"
}

prepare_profile() {
  local output="$1"
  local gateway="$2"
  local enrollment_file="$3"
  local info_file="$4"
  local models

  models="$(json_array "$info_file" models)" || fail 'gateway response is missing models'
  printf '{"%s":"active"}\n' "$JSON_SETUP_MARKER" >"$output"
  /usr/bin/plutil -insert gateway -string "$gateway" "$output"
  /usr/bin/plutil -insert authMethod -string apiKey "$output"
  /usr/bin/plutil -insert tenantId -string "$(json_value "$info_file" tenantId)" "$output"
  /usr/bin/plutil -insert objectId -string "$(json_value "$info_file" objectId)" "$output"
  /usr/bin/plutil -insert githubLogin -string "$(json_value "$info_file" githubLogin)" "$output"
  /usr/bin/plutil -insert githubAccountId -integer "$(json_value "$info_file" githubAccountId)" "$output"
  /usr/bin/plutil -insert models -json "$models" "$output"
  /usr/bin/plutil -insert bindingRevision -integer "$(json_value "$info_file" bindingRevision)" "$output"
  /usr/bin/plutil -remove "$JSON_SETUP_MARKER" "$output"
  /usr/bin/plutil -convert json "$output"
  /bin/chmod 0600 "$output"

  [ "$(json_value "$enrollment_file" tenantId)" = "$(json_value "$info_file" tenantId)" ] ||
    fail 'enterprise binding tenant does not match the enrollment'
  [ "$(json_value "$enrollment_file" objectId)" = "$(json_value "$info_file" objectId)" ] ||
    fail 'enterprise binding object does not match the enrollment'
  [ "$(json_value "$enrollment_file" githubLogin | /usr/bin/tr '[:upper:]' '[:lower:]')" = \
    "$(json_value "$info_file" githubLogin | /usr/bin/tr '[:upper:]' '[:lower:]')" ] ||
    fail 'enterprise binding GitHub login does not match the enrollment'
  [ "$(json_value "$enrollment_file" githubAccountId)" = "$(json_value "$info_file" githubAccountId)" ] ||
    fail 'enterprise binding GitHub account does not match the enrollment'
  [ "$(json_array "$enrollment_file" models)" = "$models" ] ||
    fail 'enterprise binding models do not match the enrollment'
}

enroll() {
  local gateway="$DEFAULT_GATEWAY"
  local code=''
  local tmp_dir
  local response
  local body
  local status
  local interval
  local expires_in
  local deadline
  local api_key
  local service
  local key_saved=0
  local default_model
  local model_count

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --gateway)
        [ "$#" -ge 2 ] || fail '--gateway requires a value'
        gateway="${2%/}"
        shift 2
        ;;
      --code)
        [ "$#" -ge 2 ] || fail '--code requires a value'
        code="$2"
        shift 2
        ;;
      *) fail "unknown enrollment option: $1" ;;
    esac
  done

  validate_gateway "$gateway"
  validate_code "$code"
  require_macos_tools
  require_claude_version
  install_self

  tmp_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ccgc-enroll.XXXXXX")"
  TEMP_DIR="$tmp_dir"
  response="$tmp_dir/response.json"
  body="$tmp_dir/body.json"
  trap cleanup_temp EXIT

  write_body "$body" "{\"code\":\"$code\"}"
  request_json POST "$gateway/ccgc/enroll/start" '' "$body" "$response"
  status="$(json_value "$response" status)"

  if [ "$status" = 'authorization_required' ]; then
    [ "$(json_value "$response" verificationUri)" = 'https://github.com/login/device' ] ||
      fail 'gateway returned an unexpected GitHub authorization URL'
    interval="$(json_value "$response" interval)"
    expires_in="$(json_value "$response" expiresIn)"
    [[ "$interval" =~ ^[0-9]+$ ]] && [ "$interval" -ge 1 ] ||
      fail 'gateway returned an invalid polling interval'
    [[ "$expires_in" =~ ^[0-9]+$ ]] && [ "$expires_in" -ge 1 ] ||
      fail 'gateway returned an invalid authorization expiry'
    deadline=$(( $(/bin/date +%s) + expires_in ))

    printf 'Authorize the assigned GitHub account %s.\n' "$(json_value "$response" githubLogin)"
    printf 'Open https://github.com/login/device and enter code: %s\n' \
      "$(json_value "$response" userCode)"
    /usr/bin/open 'https://github.com/login/device' >/dev/null 2>&1 || true

    while :; do
      /bin/sleep "$interval"
      [ $(( $(/bin/date +%s) + interval )) -lt "$deadline" ] ||
        fail 'GitHub authorization expired; create a new enrollment and run again'
      request_json POST "$gateway/ccgc/enroll/poll" '' "$body" "$response"
      status="$(json_value "$response" status)"
      case "$status" in
        completed) break ;;
        pending|finalizing) ;;
        slow_down) interval=$(( interval + 5 )) ;;
        denied) fail 'GitHub authorization was denied' ;;
        expired) fail 'GitHub authorization expired; create a new enrollment and run again' ;;
        no_copilot_seat) fail 'the authorized GitHub account has no GitHub Copilot entitlement' ;;
        *) fail "gateway returned unsupported enrollment status: $status" ;;
      esac
    done
  elif [ "$status" != 'completed' ]; then
    fail "gateway returned unsupported enrollment status: $status"
  fi

  api_key="$(json_value "$response" apiKey)"
  validate_api_key "$api_key"

  request_json GET "$gateway/ccgc/enterprise/info" "$api_key" '' "$tmp_dir/info.json"
  default_model="$(json_value "$tmp_dir/info.json" models.0)"
  [[ "$default_model" =~ ^claude-[a-z0-9.-]+$ ]] ||
    fail 'gateway returned an invalid default model'

  prepare_profile "$tmp_dir/profile.json" "$gateway" "$response" "$tmp_dir/info.json"
  prepare_settings "$gateway" "$default_model" "$tmp_dir/settings.json"

  service="$(api_key_service "$gateway")"
  keychain_set "$service" "$api_key"
  key_saved=1
  if ! /bin/mkdir -p "$(dirname "$PROFILE_PATH")" "$(dirname "$SETTINGS_PATH")" ||
    ! /bin/mv "$tmp_dir/profile.json" "$PROFILE_PATH" ||
    ! /bin/mv "$tmp_dir/settings.json" "$SETTINGS_PATH"; then
    [ "$key_saved" -eq 0 ] || keychain_delete "$service"
    fail 'could not install the enterprise profile and Claude settings'
  fi

  request_json POST "$gateway/ccgc/enroll/complete" '' "$body" "$tmp_dir/complete.json"
  model_count="$(json_array "$tmp_dir/info.json" models | /usr/bin/grep -o '"claude-[^"]*"' | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
  printf 'Enrollment complete for GitHub account %s (%s).\n' \
    "$(json_value "$tmp_dir/info.json" githubLogin)" \
    "$(json_value "$tmp_dir/info.json" githubAccountId)"
  printf 'Configured %s approved model(s). The employee key expires at %s.\n' \
    "$model_count" "$(json_value "$response" apiKeyExpiresAt)"
}

expiry_millis() {
  local normalized
  local seconds
  normalized="$(printf '%s' "$1" | /usr/bin/sed -E 's/\.[0-9]+Z$/Z/; s/Z$/+0000/')"
  seconds="$(/bin/date -j -f '%Y-%m-%dT%H:%M:%S%z' "$normalized" '+%s' 2>/dev/null)" ||
    fail 'gateway returned an invalid admission expiry'
  printf '%s000' "$seconds"
}

update_grant() {
  local id="$1"
  local expires="$2"
  local temporary="$PROFILE_PATH.$$.tmp"
  /bin/cp "$PROFILE_PATH" "$temporary"
  if ! /usr/bin/plutil -extract grant json -o - "$temporary" >/dev/null 2>&1; then
    /usr/bin/plutil -insert grant -dictionary "$temporary"
  fi
  plist_set_string "$temporary" grant.id "$id"
  if /usr/bin/plutil -extract grant.expires raw -o - "$temporary" >/dev/null 2>&1; then
    /usr/bin/plutil -replace grant.expires -integer "$expires" "$temporary"
  else
    /usr/bin/plutil -insert grant.expires -integer "$expires" "$temporary"
  fi
  /usr/bin/plutil -convert json "$temporary"
  /bin/chmod 0600 "$temporary"
  /bin/mv "$temporary" "$PROFILE_PATH"
}

token() {
  local gateway
  local expires
  local now
  local service
  local admission
  local api_key
  local tmp_dir
  local body
  local response
  local id

  require_macos_tools
  [ -f "$PROFILE_PATH" ] || fail 'enterprise profile is unavailable; run enrollment first'
  valid_json "$PROFILE_PATH" || fail 'enterprise profile is invalid'
  gateway="$(json_value "$PROFILE_PATH" gateway)"
  validate_gateway "$gateway"
  service="$(admission_service "$gateway")"
  expires="$(json_raw "$PROFILE_PATH" grant.expires 2>/dev/null || true)"
  now=$(( $(/bin/date +%s) * 1000 ))
  if [[ "$expires" =~ ^[0-9]+$ ]] && [ "$expires" -gt $(( now + 300000 )) ]; then
    admission="$(keychain_get "$service" || true)"
    if [[ "$admission" =~ ^[a-f0-9]{64}$ ]]; then
      printf '%s\n' "$admission"
      return
    fi
  fi

  api_key="$(keychain_get "$(api_key_service "$gateway")" || true)"
  validate_api_key "$api_key"
  tmp_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ccgc-token.XXXXXX")"
  TEMP_DIR="$tmp_dir"
  trap cleanup_temp EXIT
  body="$tmp_dir/body.json"
  response="$tmp_dir/response.json"
  write_body "$body" '{"ttlSeconds":28800,"maxAttempts":50}'
  request_json POST "$gateway/ccgc/enterprise/admissions" "$api_key" "$body" "$response"
  admission="$(json_value "$response" token)"
  validate_admission "$admission"
  id="$(json_value "$response" id)"
  expires="$(expiry_millis "$(json_value "$response" expiresAt)")"
  keychain_set "$service" "$admission"
  if ! update_grant "$id" "$expires"; then
    keychain_delete "$service"
    fail 'could not record the admission'
  fi
  printf '%s\n' "$admission"
}

models() {
  [ -f "$PROFILE_PATH" ] || fail 'enterprise profile is unavailable; run enrollment first'
  printf 'Default: %s\n' "$(json_value "$PROFILE_PATH" models.0)"
  printf 'Approved models: %s\n' "$(json_array "$PROFILE_PATH" models)"
  printf 'Binding revision: %s\n' "$(json_value "$PROFILE_PATH" bindingRevision)"
}

configure() {
  local gateway
  local default_model
  local tmp_dir
  require_macos_tools
  require_claude_version
  install_self
  [ -f "$PROFILE_PATH" ] || fail 'enterprise profile is unavailable; run enrollment first'
  gateway="$(json_value "$PROFILE_PATH" gateway)"
  default_model="$(json_value "$PROFILE_PATH" models.0)"
  tmp_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ccgc-configure.XXXXXX")"
  TEMP_DIR="$tmp_dir"
  trap cleanup_temp EXIT
  prepare_settings "$gateway" "$default_model" "$tmp_dir/settings.json"
  /bin/mkdir -p "$(dirname "$SETTINGS_PATH")"
  /bin/mv "$tmp_dir/settings.json" "$SETTINGS_PATH"
  printf 'Claude Code configuration updated.\n'
}

command="${1:-help}"
if [ "$#" -gt 0 ]; then
  shift
fi
case "$command" in
  enroll) enroll "$@" ;;
  token) [ "$#" -eq 0 ] || fail 'token does not accept options'; token ;;
  models) [ "$#" -eq 0 ] || fail 'models does not accept options'; models ;;
  configure) [ "$#" -eq 0 ] || fail 'configure does not accept options'; configure ;;
  help|-h|--help) usage ;;
  *) fail "unknown command: $command" ;;
esac
