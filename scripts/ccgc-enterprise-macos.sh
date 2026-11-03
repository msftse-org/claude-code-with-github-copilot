#!/bin/bash

set -euo pipefail
umask 077

DEFAULT_GATEWAY='https://ca-ccgc-pilot-broker.bluefield-2d967d14.swedencentral.azurecontainerapps.io'
MINIMUM_CLAUDE_VERSION='2.1.296'
INSTALL_PATH="$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh"
PROFILE_PATH="$HOME/.local/share/ccgc/enterprise/profile.json"
SETTINGS_PATH="$HOME/.claude/settings.json"
JSON_SETUP_MARKER='__ccgc_setup_719ee977'
TEMP_DIR=''
PREAPPROVED_SETTING_CONFLICTS=''
DETECTED_CLAUDE_VERSION=''

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
    "$TEMP_DIR/config.json" \
    "$TEMP_DIR/health.json" \
    "$TEMP_DIR/info.json" \
    "$TEMP_DIR/admission.json" \
    "$TEMP_DIR/admission-body.json" \
    "$TEMP_DIR/models.json" \
    "$TEMP_DIR/probe.json" \
    "$TEMP_DIR/probe-body.json" \
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
  bash ccgc-enterprise-macos.sh doctor

The enrollment command verifies the assigned GitHub account, stores the
30-day employee key in macOS Keychain, and configures both the Claude Code CLI
and the Code tab in Claude Desktop through their shared settings profile. It
does not disable Gatekeeper, remove quarantine attributes, or change MDM policy.
Existing employees do not repeat enrollment for routine service, model, script,
or Claude Code updates. Run doctor first; use models or configure when needed.
Enroll again only with a new Enterprise IT code for credential, identity,
workstation, or explicitly announced migration recovery.
The doctor command checks local configuration, gateway health, model discovery,
and a real bounded inference request without printing credentials.
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
  local current_major
  local current_minor
  local current_patch
  local minimum_major
  local minimum_minor
  local minimum_patch
  command -v claude >/dev/null 2>&1 ||
    fail "Claude Code $MINIMUM_CLAUDE_VERSION or newer is required; install it before enrollment"
  output="$(claude --version 2>/dev/null)" ||
    fail 'could not determine the installed Claude Code version'
  if [[ "$output" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    version="${BASH_REMATCH[1]}"
  else
    fail 'could not parse the installed Claude Code version'
  fi
  IFS='.' read -r current_major current_minor current_patch <<<"$version"
  IFS='.' read -r minimum_major minimum_minor minimum_patch <<<"$MINIMUM_CLAUDE_VERSION"
  if [ "$current_major" -lt "$minimum_major" ] ||
    { [ "$current_major" -eq "$minimum_major" ] && [ "$current_minor" -lt "$minimum_minor" ]; } ||
    { [ "$current_major" -eq "$minimum_major" ] && [ "$current_minor" -eq "$minimum_minor" ] &&
      [ "$current_patch" -lt "$minimum_patch" ]; }; then
    fail "Claude Code $MINIMUM_CLAUDE_VERSION or newer is required (found $version); run 'claude install $MINIMUM_CLAUDE_VERSION'"
  fi
  DETECTED_CLAUDE_VERSION="$version"
}

claude_desktop_version() {
  local app='/Applications/Claude.app'
  local info="$app/Contents/Info.plist"
  local bundle_id
  local version

  [ -d "$app" ] || return 1
  [ -f "$info" ] || fail 'Claude Desktop has an invalid application bundle'
  bundle_id="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$info" 2>/dev/null)" ||
    fail 'could not identify the installed Claude Desktop application'
  [ "$bundle_id" = 'com.anthropic.claudefordesktop' ] ||
    fail 'the installed Claude Desktop application is not the official Anthropic build'
  version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$info" 2>/dev/null)" ||
    fail 'could not determine the installed Claude Desktop version'
  [[ "$version" =~ ^[0-9]+(\.[0-9]+)+$ ]] ||
    fail 'could not parse the installed Claude Desktop version'
  printf '%s' "$version"
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

file_stat() {
  local bsd_format="$1"
  local gnu_format="$2"
  local path="$3"
  if /usr/bin/stat --version >/dev/null 2>&1; then
    /usr/bin/stat -c "$gnu_format" "$path" 2>/dev/null
  else
    /usr/bin/stat -f "$bsd_format" "$path" 2>/dev/null
  fi
}

request_json_status() {
  local method="$1"
  local url="$2"
  local bearer="$3"
  local body_file="$4"
  local output_file="$5"
  local timeout="${6:-30}"
  local code
  local curl_args=(
    --silent
    --show-error
    --max-time "$timeout"
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
  printf '%s' "$code"
}

request_json() {
  local method="$1"
  local url="$2"
  local bearer="$3"
  local body_file="$4"
  local output_file="$5"
  local timeout="${6:-30}"
  local code
  local message

  code="$(request_json_status "$method" "$url" "$bearer" "$body_file" "$output_file" "$timeout")"
  case "$code" in
    2??) ;;
    *)
      if valid_json "$output_file"; then
        message="$(json_raw "$output_file" error.message 2>/dev/null || true)"
        [ -z "$message" ] || fail "enterprise gateway returned HTTP $code: $message"
      fi
      fail "enterprise gateway returned HTTP $code"
      ;;
  esac
  valid_json "$output_file" ||
    fail 'enterprise gateway returned invalid JSON'
}

discover_inference_gateway() {
  local control_plane="$1"
  local output_file="$2"
  local code
  local error_code
  local error_message
  local gateway

  code="$(request_json_status GET "$control_plane/ccgc/enterprise/config" '' '' "$output_file")"
  case "$code" in
    2??)
      valid_json "$output_file" || fail 'enterprise gateway returned invalid JSON'
      gateway="$(json_value "$output_file" inferenceGateway)"
      ;;
    404)
      valid_json "$output_file" || fail 'enterprise gateway returned invalid JSON'
      error_code="$(json_raw "$output_file" error.code 2>/dev/null || true)"
      error_message="$(json_raw "$output_file" error.message 2>/dev/null || true)"
      if [ "$error_code" != 'ROUTE_UNSUPPORTED' ] &&
        [[ "$error_message" != ROUTE_UNSUPPORTED:* ]]; then
        fail 'enterprise gateway does not expose central LiteLLM discovery'
      fi
      gateway="$control_plane"
      ;;
    *)
      if valid_json "$output_file"; then
        error_code="$(json_raw "$output_file" error.message 2>/dev/null || true)"
        [ -z "$error_code" ] ||
          fail "enterprise gateway returned HTTP $code: $error_code"
      fi
      fail "enterprise gateway returned HTTP $code"
      ;;
  esac
  validate_gateway "$gateway"
  printf '%s' "$gateway"
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

preflight_enrollment_settings() {
  local gateway="$1"
  local helper
  local existing
  local key
  local choice
  local setting_conflicts=()

  for key in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
    [ -z "${!key-}" ] ||
      fail "shell environment setting $key conflicts with the enterprise gateway; run 'unset $key' and retry"
  done
  if [ -n "${ANTHROPIC_BASE_URL-}" ] && [ "$ANTHROPIC_BASE_URL" != "$gateway" ]; then
    fail "shell environment setting ANTHROPIC_BASE_URL conflicts with the enterprise gateway; run 'unset ANTHROPIC_BASE_URL' and retry"
  fi

  [ ! -L "$SETTINGS_PATH" ] ||
    fail 'existing Claude settings must not be a symlink'
  [ -e "$SETTINGS_PATH" ] || return 0
  [ -f "$SETTINGS_PATH" ] ||
    fail 'existing Claude settings must be a regular file'
  [ "$(file_stat '%u' '%u' "$SETTINGS_PATH")" = "$(/usr/bin/id -u)" ] ||
    fail 'existing Claude settings must be owned by the current user'
  valid_json "$SETTINGS_PATH" ||
    fail 'existing Claude settings are not valid JSON'
  if json_raw "$SETTINGS_PATH" "$JSON_SETUP_MARKER" >/dev/null 2>&1; then
    fail 'Claude settings contain a reserved CCGC setup key'
  fi

  helper="$(installed_helper)"
  existing="$(json_raw "$SETTINGS_PATH" apiKeyHelper 2>/dev/null || true)"
  if [ -n "$existing" ] && [ "$existing" != "$helper" ]; then
    setting_conflicts+=('apiKeyHelper')
  fi
  for key in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
    if json_raw "$SETTINGS_PATH" "env.$key" >/dev/null 2>&1; then
      setting_conflicts+=("$key")
    fi
  done
  existing="$(json_raw "$SETTINGS_PATH" env.ANTHROPIC_BASE_URL 2>/dev/null || true)"
  if [ -n "$existing" ] && [ "$existing" != "$gateway" ]; then
    setting_conflicts+=('ANTHROPIC_BASE_URL')
  fi
  [ "${#setting_conflicts[@]}" -gt 0 ] || return 0

  printf 'Existing Claude setting(s) conflict with the enterprise gateway:\n' >&2
  for key in "${setting_conflicts[@]}"; do
    printf '  - %s\n' "$key" >&2
  done
  printf '\nChoose an action before the enrollment code is used:\n' >&2
  printf '  1. After gateway verification, back up Claude settings and replace only these enterprise-managed settings.\n' >&2
  printf '  2. Cancel without using the enrollment code or changing Claude settings.\n' >&2
  printf 'Enter 1 or 2: ' >&2
  IFS= read -r choice ||
    fail 'interactive confirmation is required to resolve existing Claude credentials'
  case "$choice" in
    1)
      for key in "${setting_conflicts[@]}"; do
        PREAPPROVED_SETTING_CONFLICTS="${PREAPPROVED_SETTING_CONFLICTS}|$key|"
      done
      ;;
    2) fail 'enrollment cancelled; the enrollment code and Claude settings were not changed' ;;
    *) fail 'invalid choice; the enrollment code and Claude settings were not changed' ;;
  esac
}

require_private_file() {
  local path="$1"
  local label="$2"
  [ -f "$path" ] && [ ! -L "$path" ] ||
    fail "$label must be a non-symlink regular file"
  [ "$(file_stat '%u' '%u' "$path")" = "$(/usr/bin/id -u)" ] ||
    fail "$label must be owned by the current user"
  [ "$(file_stat '%Lp' '%a' "$path")" = '600' ] ||
    fail "$label must have mode 0600"
}

model_display_name() {
  local model="$1"
  local family
  local version
  family="${model#claude-}"
  version="${family#*-}"
  family="${family%%-*}"
  case "$family" in
    sonnet) printf 'Claude Sonnet %s' "$version" ;;
    haiku) printf 'Claude Haiku %s' "$version" ;;
    opus) printf 'Claude Opus %s' "$version" ;;
    *) printf '%s' "$model" ;;
  esac
}

verify_gateway_health() {
  local gateway="$1"
  local output="$2"
  request_json GET "$gateway/healthz" '' '' "$output"
  [ "$(json_value "$output" status)" = 'listening' ] ||
    fail 'enterprise gateway is not listening'
}

verify_gateway_access() {
  local control_plane="$1"
  local gateway="$2"
  local api_key="$3"
  local default_model="$4"
  local tmp_dir="$5"
  local admission
  local client_id
  local display_name
  local expected_display
  local found=0
  local index=0
  local model_id
  local output_limit=16
  local response_model
  local response_text=''
  local block_type

  write_body "$tmp_dir/admission-body.json" '{"ttlSeconds":300,"maxAttempts":3}'
  request_json POST "$control_plane/ccgc/enterprise/admissions" "$api_key" \
    "$tmp_dir/admission-body.json" "$tmp_dir/admission.json"
  admission="$(json_value "$tmp_dir/admission.json" token)"
  validate_admission "$admission"

  request_json GET "$gateway/v1/models" "$admission" '' "$tmp_dir/models.json"
  client_id="$(client_model "$default_model")"
  expected_display="$(model_display_name "$default_model")"
  while model_id="$(json_raw "$tmp_dir/models.json" "data.$index.id" 2>/dev/null)"; do
    if [ "$model_id" = "$client_id" ] || [ "$model_id" = "$default_model" ]; then
      display_name="$(json_raw "$tmp_dir/models.json" "data.$index.display_name" 2>/dev/null || true)"
      if [ -n "$display_name" ] && [ "$display_name" != "$expected_display" ]; then
        fail "gateway model display mismatch: expected $expected_display, received $display_name"
      fi
      found=1
      break
    fi
    index=$(( index + 1 ))
  done
  [ "$found" -eq 1 ] ||
    fail "approved model $default_model is missing from gateway discovery"

  [ "$default_model" != 'claude-sonnet-5.5' ] || output_limit=128000
  write_body "$tmp_dir/probe-body.json" \
    "{\"model\":\"$default_model\",\"max_tokens\":$output_limit,\"messages\":[{\"role\":\"user\",\"content\":\"Reply exactly CCGC_CLIENT_READY.\"}]}"
  request_json POST "$gateway/v1/messages" "$admission" \
    "$tmp_dir/probe-body.json" "$tmp_dir/probe.json" 180
  response_model="$(json_value "$tmp_dir/probe.json" model)"
  [ "$response_model" = "$default_model" ] ||
    fail "gateway inference returned unexpected model $response_model"
  index=0
  while block_type="$(json_raw "$tmp_dir/probe.json" "content.$index.type" 2>/dev/null)"; do
    if [ "$block_type" = 'text' ]; then
      response_text="${response_text}$(json_value "$tmp_dir/probe.json" "content.$index.text")"
    fi
    index=$(( index + 1 ))
  done
  [ "$response_text" = 'CCGC_CLIENT_READY' ] ||
    fail 'gateway inference probe returned an unexpected response'
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
  printf '%s' "$1"
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
  local confirmation_required=0
  local setting_conflicts=()

  helper="$(installed_helper)"
  if [ -f "$SETTINGS_PATH" ]; then
    [ ! -L "$SETTINGS_PATH" ] || fail 'existing Claude settings must not be a symlink'
    [ "$(file_stat '%u' '%u' "$SETTINGS_PATH")" = "$(/usr/bin/id -u)" ] ||
      fail 'existing Claude settings must be owned by the current user'
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
    setting_conflicts+=('apiKeyHelper')
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
    for key in "${setting_conflicts[@]}"; do
      case "$PREAPPROVED_SETTING_CONFLICTS" in
        *"|$key|"*) ;;
        *) confirmation_required=1 ;;
      esac
    done
    choice=1
    if [ "$confirmation_required" -eq 1 ]; then
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
    fi
    case "$choice" in
      1)
        backup_path="$SETTINGS_PATH.ccgc-backup.$(/bin/date -u '+%Y%m%dT%H%M%SZ')"
        [ -f "$SETTINGS_PATH" ] || fail 'Claude settings disappeared before backup'
        /bin/cp -p "$SETTINGS_PATH" "$backup_path"
        /bin/chmod 0600 "$backup_path"
        for key in "${setting_conflicts[@]}"; do
          if [ "$key" = 'apiKeyHelper' ]; then
            /usr/bin/plutil -remove "$key" "$output"
          else
            /usr/bin/plutil -remove "env.$key" "$output"
          fi
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
  plist_set_string "$output" model "$(client_model "$default_model")"
  plist_set_string "$output" apiKeyHelper "$helper"
  /usr/bin/plutil -remove "$JSON_SETUP_MARKER" "$output"
  /usr/bin/plutil -convert json "$output"
}

prepare_profile() {
  local output="$1"
  local control_plane="$2"
  local gateway="$3"
  local enrollment_file="$4"
  local info_file="$5"
  local models

  models="$(json_array "$info_file" models)" || fail 'gateway response is missing models'
  printf '{"%s":"active"}\n' "$JSON_SETUP_MARKER" >"$output"
  /usr/bin/plutil -insert controlPlane -string "$control_plane" "$output"
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

refresh_profile() {
  local tmp_dir="$1"
  local control_plane
  local gateway
  local api_key
  local info_file="$tmp_dir/info.json"
  local output="$tmp_dir/profile.json"
  local models

  require_private_file "$PROFILE_PATH" 'enterprise profile'
  valid_json "$PROFILE_PATH" || fail 'enterprise profile is invalid'
  control_plane="$(json_raw "$PROFILE_PATH" controlPlane 2>/dev/null || json_value "$PROFILE_PATH" gateway)"
  gateway="$(json_value "$PROFILE_PATH" gateway)"
  validate_gateway "$control_plane"
  validate_gateway "$gateway"
  api_key="$(keychain_get "$(api_key_service "$control_plane")" || true)"
  validate_api_key "$api_key"
  request_json GET "$control_plane/ccgc/enterprise/info" "$api_key" '' "$info_file"
  [ "$(json_value "$info_file" inferenceGateway)" = "$gateway" ] ||
    fail 'enterprise profile central LiteLLM gateway no longer matches the control plane'
  [ "$(json_value "$PROFILE_PATH" tenantId)" = "$(json_value "$info_file" tenantId)" ] ||
    fail 'enterprise profile tenant no longer matches the gateway binding'
  [ "$(json_value "$PROFILE_PATH" objectId)" = "$(json_value "$info_file" objectId)" ] ||
    fail 'enterprise profile user no longer matches the gateway binding'
  [ "$(json_value "$PROFILE_PATH" githubAccountId)" = "$(json_value "$info_file" githubAccountId)" ] ||
    fail 'enterprise profile GitHub account no longer matches the gateway binding'
  models="$(json_array "$info_file" models)" || fail 'gateway response is missing models'
  /bin/cp "$PROFILE_PATH" "$output"
  /usr/bin/plutil -replace models -json "$models" "$output"
  /usr/bin/plutil -replace bindingRevision -integer "$(json_value "$info_file" bindingRevision)" "$output"
  /usr/bin/plutil -convert json "$output"
  /bin/chmod 0600 "$output"
  /bin/mv "$output" "$PROFILE_PATH"
}

enroll() {
  local control_plane="$DEFAULT_GATEWAY"
  local gateway
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
  local advertised_gateway

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --gateway)
        [ "$#" -ge 2 ] || fail '--gateway requires a value'
        control_plane="${2%/}"
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

  validate_gateway "$control_plane"
  validate_code "$code"
  require_macos_tools
  require_claude_version

  tmp_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ccgc-enroll.XXXXXX")"
  TEMP_DIR="$tmp_dir"
  response="$tmp_dir/response.json"
  body="$tmp_dir/body.json"
  trap cleanup_temp EXIT

  verify_gateway_health "$control_plane" "$tmp_dir/health.json"
  gateway="$(discover_inference_gateway "$control_plane" "$tmp_dir/config.json")"
  preflight_enrollment_settings "$gateway"
  install_self
  write_body "$body" "{\"code\":\"$code\"}"
  request_json POST "$control_plane/ccgc/enroll/start" '' "$body" "$response"
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
      request_json POST "$control_plane/ccgc/enroll/poll" '' "$body" "$response"
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

  request_json GET "$control_plane/ccgc/enterprise/info" "$api_key" '' "$tmp_dir/info.json"
  advertised_gateway="$(json_raw "$tmp_dir/info.json" inferenceGateway 2>/dev/null || true)"
  if [ -n "$advertised_gateway" ]; then
    [ "$advertised_gateway" = "$gateway" ] ||
      fail 'control plane changed the central LiteLLM gateway during enrollment'
  else
    [ "$gateway" = "$control_plane" ] ||
      fail 'control plane omitted the configured central LiteLLM gateway'
  fi
  default_model="$(json_value "$tmp_dir/info.json" models.0)"
  [[ "$default_model" =~ ^claude-[a-z0-9.-]+$ ]] ||
    fail 'gateway returned an invalid default model'

  verify_gateway_access "$control_plane" "$gateway" "$api_key" "$default_model" "$tmp_dir"
  prepare_profile "$tmp_dir/profile.json" "$control_plane" "$gateway" "$response" "$tmp_dir/info.json"
  prepare_settings "$gateway" "$default_model" "$tmp_dir/settings.json"

  service="$(api_key_service "$control_plane")"
  keychain_set "$service" "$api_key"
  key_saved=1
  if ! /bin/mkdir -p "$(dirname "$PROFILE_PATH")" "$(dirname "$SETTINGS_PATH")" ||
    ! /bin/mv "$tmp_dir/profile.json" "$PROFILE_PATH" ||
    ! /bin/mv "$tmp_dir/settings.json" "$SETTINGS_PATH"; then
    [ "$key_saved" -eq 0 ] || keychain_delete "$service"
    fail 'could not install the enterprise profile and Claude settings'
  fi

  request_json POST "$control_plane/ccgc/enroll/complete" '' "$body" "$tmp_dir/complete.json"
  model_count="$(json_array "$tmp_dir/info.json" models | /usr/bin/grep -o '"claude-[^"]*"' | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
  printf 'Enrollment complete for GitHub account %s (%s).\n' \
    "$(json_value "$tmp_dir/info.json" githubLogin)" \
    "$(json_value "$tmp_dir/info.json" githubAccountId)"
  printf 'Configured %s approved model(s). The employee key expires at %s.\n' \
    "$model_count" "$(json_value "$response" apiKeyExpiresAt)"
  if [ -d '/Applications/Claude.app' ]; then
    printf 'Fully quit and reopen Claude Desktop, then use its Code tab to load the shared enterprise settings.\n'
  fi
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
  local control_plane
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
  control_plane="$(json_raw "$PROFILE_PATH" controlPlane 2>/dev/null || json_value "$PROFILE_PATH" gateway)"
  gateway="$(json_value "$PROFILE_PATH" gateway)"
  validate_gateway "$control_plane"
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

  api_key="$(keychain_get "$(api_key_service "$control_plane")" || true)"
  validate_api_key "$api_key"
  tmp_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ccgc-token.XXXXXX")"
  TEMP_DIR="$tmp_dir"
  trap cleanup_temp EXIT
  body="$tmp_dir/body.json"
  response="$tmp_dir/response.json"
  write_body "$body" '{"ttlSeconds":28800,"maxAttempts":50}'
  request_json POST "$control_plane/ccgc/enterprise/admissions" "$api_key" "$body" "$response"
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
  tmp_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ccgc-configure.XXXXXX")"
  TEMP_DIR="$tmp_dir"
  trap cleanup_temp EXIT
  refresh_profile "$tmp_dir"
  gateway="$(json_value "$PROFILE_PATH" gateway)"
  default_model="$(json_value "$PROFILE_PATH" models.0)"
  prepare_settings "$gateway" "$default_model" "$tmp_dir/settings.json"
  /bin/mkdir -p "$(dirname "$SETTINGS_PATH")"
  /bin/mv "$tmp_dir/settings.json" "$SETTINGS_PATH"
  printf 'Claude Code configuration updated.\n'
  if [ -d '/Applications/Claude.app' ]; then
    printf 'Fully quit and reopen Claude Desktop, then use its Code tab to load the shared enterprise settings.\n'
  fi
}

doctor() {
  local control_plane
  local gateway
  local default_model
  local expected_model
  local helper
  local existing
  local api_key
  local tmp_dir
  local desktop_version

  require_macos_tools
  require_claude_version
  require_private_file "$INSTALL_PATH" 'installed enterprise helper'
  require_private_file "$PROFILE_PATH" 'enterprise profile'
  require_private_file "$SETTINGS_PATH" 'Claude settings'
  valid_json "$PROFILE_PATH" || fail 'enterprise profile is invalid'
  valid_json "$SETTINGS_PATH" || fail 'Claude settings are invalid'
  control_plane="$(json_raw "$PROFILE_PATH" controlPlane 2>/dev/null || json_value "$PROFILE_PATH" gateway)"
  gateway="$(json_value "$PROFILE_PATH" gateway)"
  validate_gateway "$control_plane"
  validate_gateway "$gateway"
  default_model="$(json_value "$PROFILE_PATH" models.0)"
  [[ "$default_model" =~ ^claude-[a-z0-9.-]+$ ]] ||
    fail 'enterprise profile contains an invalid default model'
  expected_model="$(client_model "$default_model")"
  helper="$(installed_helper)"

  for existing in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
    [ -z "${!existing-}" ] ||
      fail "shell environment setting $existing conflicts with the enterprise gateway; run 'unset $existing'"
    if json_raw "$SETTINGS_PATH" "env.$existing" >/dev/null 2>&1; then
      fail "Claude settings still contain conflicting credential $existing"
    fi
  done
  if [ -n "${ANTHROPIC_BASE_URL-}" ] && [ "$ANTHROPIC_BASE_URL" != "$gateway" ]; then
    fail "shell environment setting ANTHROPIC_BASE_URL conflicts with the enterprise gateway; run 'unset ANTHROPIC_BASE_URL'"
  fi
  if [ -n "${ANTHROPIC_DEFAULT_MODEL-}" ] && [ "$ANTHROPIC_DEFAULT_MODEL" != "$expected_model" ]; then
    fail "shell environment setting ANTHROPIC_DEFAULT_MODEL conflicts with the approved model; run 'unset ANTHROPIC_DEFAULT_MODEL'"
  fi

  [ "$(json_value "$SETTINGS_PATH" env.ANTHROPIC_BASE_URL)" = "$gateway" ] ||
    fail 'Claude settings do not route to the enrolled enterprise gateway'
  [ "$(json_value "$SETTINGS_PATH" env.ANTHROPIC_DEFAULT_MODEL)" = "$expected_model" ] ||
    fail 'Claude settings do not select the approved default model'
  [ "$(json_value "$SETTINGS_PATH" model)" = "$expected_model" ] ||
    fail 'Claude settings retain a conflicting default model'
  [ "$(json_value "$SETTINGS_PATH" env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY)" = '1' ] ||
    fail 'Claude gateway model discovery is not enabled'
  [ "$(json_value "$SETTINGS_PATH" env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS)" = '60000' ] ||
    fail 'Claude credential-helper caching is not configured safely'
  [ "$(json_value "$SETTINGS_PATH" env.CLAUDE_CODE_AUTO_MODE_SERVER)" = '0' ] ||
    fail 'Claude local auto-mode routing is not configured'
  [ "$(json_value "$SETTINGS_PATH" apiKeyHelper)" = "$helper" ] ||
    fail 'Claude settings do not use the installed enterprise credential helper'
  json_raw "$SETTINGS_PATH" permissions.defaultMode >/dev/null 2>&1 ||
    fail 'Claude permission default is missing'
  if json_raw "$PROFILE_PATH" apiKey >/dev/null 2>&1 ||
    json_raw "$PROFILE_PATH" token >/dev/null 2>&1; then
    fail 'enterprise profile must not contain credentials'
  fi

  api_key="$(keychain_get "$(api_key_service "$control_plane")" || true)"
  validate_api_key "$api_key"
  tmp_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ccgc-doctor.XXXXXX")"
  TEMP_DIR="$tmp_dir"
  trap cleanup_temp EXIT
  verify_gateway_health "$control_plane" "$tmp_dir/health.json"
  request_json GET "$control_plane/ccgc/enterprise/info" "$api_key" '' "$tmp_dir/info.json"
  [ "$(json_value "$tmp_dir/info.json" inferenceGateway)" = "$gateway" ] ||
    fail 'enterprise profile central LiteLLM gateway no longer matches the control plane'
  [ "$(json_value "$PROFILE_PATH" tenantId)" = "$(json_value "$tmp_dir/info.json" tenantId)" ] ||
    fail 'enterprise profile tenant no longer matches the gateway binding'
  [ "$(json_value "$PROFILE_PATH" objectId)" = "$(json_value "$tmp_dir/info.json" objectId)" ] ||
    fail 'enterprise profile user no longer matches the gateway binding'
  [ "$(json_value "$PROFILE_PATH" githubAccountId)" = "$(json_value "$tmp_dir/info.json" githubAccountId)" ] ||
    fail 'enterprise profile GitHub account no longer matches the gateway binding'
  [ "$(json_array "$PROFILE_PATH" models)" = "$(json_array "$tmp_dir/info.json" models)" ] ||
    fail 'enterprise profile models no longer match the gateway binding'
  verify_gateway_access "$control_plane" "$gateway" "$api_key" "$default_model" "$tmp_dir"

  printf 'CCGC doctor passed.\n'
  printf 'Claude Code: %s (minimum supported: %s)\n' \
    "$DETECTED_CLAUDE_VERSION" "$MINIMUM_CLAUDE_VERSION"
  if desktop_version="$(claude_desktop_version)"; then
    printf 'Claude Desktop Code: %s (shared enterprise settings verified)\n' "$desktop_version"
  else
    printf 'Claude Desktop Code: not installed; CLI profile verified\n'
  fi
  printf 'GitHub account: %s (%s)\n' \
    "$(json_value "$tmp_dir/info.json" githubLogin)" \
    "$(json_value "$tmp_dir/info.json" githubAccountId)"
  printf 'Default model: %s (%s)\n' "$default_model" "$(model_display_name "$default_model")"
  printf 'Local settings, Keychain, binding, model discovery, output limit, and inference are healthy.\n'
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
  doctor) [ "$#" -eq 0 ] || fail 'doctor does not accept options'; doctor ;;
  help|-h|--help) usage ;;
  *) fail "unknown command: $command" ;;
esac
