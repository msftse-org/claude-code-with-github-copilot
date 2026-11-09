#!/bin/bash

set -euo pipefail
umask 077

DEFAULT_GATEWAY='https://ca-ccgc-pilot-litellm.victorioussea-313182e6.swedencentral.azurecontainerapps.io'
MINIMUM_CLAUDE_VERSION='2.1.296'
INSTALL_PATH="$HOME/.local/share/ccgc/enterprise/ccgc-enterprise-macos.sh"
PROFILE_PATH="$HOME/.local/share/ccgc/enterprise/profile.json"
SETTINGS_PATH="$HOME/.claude/settings.json"
DESKTOP_PATH="$HOME/.local/share/ccgc/enterprise/desktop-gateway.json"
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
    "$TEMP_DIR/disconnect.json" \
    "$TEMP_DIR/health.json" \
    "$TEMP_DIR/info.json" \
    "$TEMP_DIR/key-info.json" \
    "$TEMP_DIR/connections.json" \
    "$TEMP_DIR/routes.json" \
    "$TEMP_DIR/verified-profile.json" \
    "$TEMP_DIR/desktop.json" \
    "$TEMP_DIR/previous-0.json" \
    "$TEMP_DIR/previous-1.json" \
    "$TEMP_DIR/previous-2.json" \
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
  bash ccgc-enterprise-macos.sh
  bash ccgc-enterprise-macos.sh enroll [--gateway HTTPS_URL] [--no-browser]
  bash ccgc-enterprise-macos.sh token
  bash ccgc-enterprise-macos.sh models
  bash ccgc-enterprise-macos.sh configure
  bash ccgc-enterprise-macos.sh doctor

Running without arguments starts enrollment and asks for your personal LiteLLM
key from your administrator (input is hidden). GitHub opens automatically in
your browser; enter the displayed device code and approve with your Copilot account.
No repository checkout, Node.js, npm, or LiteLLM login is needed.
Claude Code must already be installed.
The enrollment command verifies the LiteLLM user and connection, stores the
90-day personal LiteLLM key in macOS Keychain, and configures the Claude Code CLI.
Claude Desktop requires separate third-party gateway configuration; enrollment
writes a secret-free desktop-gateway.json import file beside the profile. This script
does not disable Gatekeeper, remove quarantine attributes, or change MDM policy.
Existing employees do not repeat enrollment for routine service, model, script,
or Claude Code updates. Run doctor first; use models or configure when needed.
Enroll again only with a new personal key from Enterprise IT for credential,
identity, workstation, or explicitly announced migration recovery.
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

litellm_key_id() {
  printf 'enterprise-verified-key\n%s\n%s\n%s' "$1" "$2" "$3" | sha256
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
    --proto '=https'
    --connect-timeout 10
    --max-filesize 1048576
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

validate_gateway() {
  [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] ||
    fail 'gateway must be an HTTPS origin without credentials, path, query, or fragment'
}

validate_litellm_key() {
  [[ "$1" =~ ^sk-[A-Za-z0-9._-]{16,}$ ]] && [ "${#1}" -le 515 ] ||
    fail 'the supplied LiteLLM key is invalid'
}

validate_github_login() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$ ]] ||
    fail 'gateway returned an invalid GitHub login'
}

lowercase() {
  /usr/bin/tr '[:upper:]' '[:lower:]'
}

preflight_enrollment_settings() {
  local gateway="$1"
  local helper
  local existing
  local key
  local choice
  local setting_conflicts=()

  for key in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
    [ -z "$(printenv "$key" 2>/dev/null || true)" ] ||
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
  printf '\nChoose an action before the LiteLLM key is used:\n' >&2
  printf '  1. After gateway verification, back up Claude settings and replace only these enterprise-managed settings.\n' >&2
  printf '  2. Cancel without using the LiteLLM key or changing Claude settings.\n' >&2
  printf 'Enter 1 or 2: ' >&2
  IFS= read -r choice ||
    fail 'interactive confirmation is required to resolve existing Claude credentials'
  case "$choice" in
    1)
      for key in "${setting_conflicts[@]}"; do
        PREAPPROVED_SETTING_CONFLICTS="${PREAPPROVED_SETTING_CONFLICTS}|$key|"
      done
      ;;
    2) fail 'enrollment cancelled; the LiteLLM key and Claude settings were not changed' ;;
    *) fail 'invalid choice; the LiteLLM key and Claude settings were not changed' ;;
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

prepare_private_directories() {
  local directory
  local mode
  for directory in "$HOME/.local" "$HOME/.local/share" "$HOME/.local/share/ccgc" \
    "$(dirname "$PROFILE_PATH")" "$(dirname "$SETTINGS_PATH")"; do
    [ ! -L "$directory" ] || fail 'configuration directories must not be symlinks'
    if [ ! -e "$directory" ]; then
      /bin/mkdir -m 700 "$directory"
    fi
    [ -d "$directory" ] && [ "$(file_stat '%u' '%u' "$directory")" = "$(/usr/bin/id -u)" ] ||
      fail 'configuration directories must be owned by the current user'
    mode="$(file_stat '%Lp' '%a' "$directory")"
    [[ "$mode" =~ ^[0-7]{3,4}$ ]] && [ $(( 8#$mode & 0022 )) -eq 0 ] ||
      fail 'configuration directories must not be writable by other users'
  done
}

require_direct_profile() {
  [ "$(json_raw "$PROFILE_PATH" authMethod 2>/dev/null || true)" = 'litellmKey' ] &&
    [ "$(json_raw "$PROFILE_PATH" inferenceAuthentication 2>/dev/null || true)" = 'directKey' ] ||
    fail 'this enrollment is no longer supported; ask Enterprise IT for a new personal LiteLLM key and run enroll again'
}

direct_profile_key() {
  local key_id
  local user_id
  local gateway
  local api_key
  require_private_file "$PROFILE_PATH" 'enterprise profile'
  [ "$(json_value "$PROFILE_PATH" inferenceAuthentication)" = 'directKey' ] ||
    fail 'personal LiteLLM profile has an invalid authentication mode'
  key_id="$(json_value "$PROFILE_PATH" keychainId)"
  [[ "$key_id" =~ ^[a-f0-9]{64}$ ]] || fail 'personal LiteLLM profile has no verified Keychain identifier; run setup again'
  user_id="$(json_value "$PROFILE_PATH" liteLLMUserId)"
  gateway="$(json_value "$PROFILE_PATH" gateway)"
  validate_gateway "$gateway"
  api_key="$(keychain_get "ccgc.remote.$key_id" || true)"
  validate_litellm_key "$api_key"
  [ "$(litellm_key_id "$gateway" "$user_id" "$api_key")" = "$key_id" ] ||
    fail 'Keychain credential does not match the verified profile'
  printf '%s' "$api_key"
}

prepare_litellm_profile() {
  local output="$1"
  local gateway="$2"
  local enrollment="$3"
  local api_key="$4"
  local user_id
  local login
  local credential
  local model
  local index=0

  user_id="$(json_value "$enrollment" litellmUserId | lowercase)"
  [[ "$user_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    fail 'gateway returned an invalid LiteLLM user'
  login="$(json_value "$enrollment" githubLogin)"
  validate_github_login "$login"
  credential="$(json_value "$enrollment" litellmCredentialName)"
  [[ "$credential" =~ ^[A-Za-z0-9._-]{1,128}$ ]] ||
    fail 'gateway returned an invalid Copilot credential name'
  while model="$(json_raw "$enrollment" "models.$index" 2>/dev/null)"; do
    [[ "$model" =~ ^claude-[a-z0-9.-]+$ ]] || fail 'gateway returned an invalid model'
    index=$(( index + 1 ))
  done
  [ "$index" -gt 0 ] || fail 'gateway returned no approved Claude models'
  [ "$(expiry_millis "$(json_value "$enrollment" apiKeyExpiresAt)")" -gt $(( $(/bin/date +%s) * 1000 )) ] ||
    fail 'gateway returned an expired personal key'

  printf '{"authMethod":"litellmKey","inferenceAuthentication":"directKey"}\n' >"$output"
  /usr/bin/plutil -insert gateway -string "$gateway" "$output"
  /usr/bin/plutil -insert liteLLMUserId -string "$user_id" "$output"
  /usr/bin/plutil -insert githubLogin -string "$login" "$output"
  /usr/bin/plutil -insert copilotCredentialName -string "$credential" "$output"
  /usr/bin/plutil -insert keychainId -string "$(litellm_key_id "$gateway" "$user_id" "$api_key")" "$output"
  /usr/bin/plutil -insert models -json "$(json_array "$enrollment" models)" "$output"
  /usr/bin/plutil -convert json "$output"
}

verify_litellm_profile() {
  local gateway="$1"
  local api_key="$2"
  local expected="$3"
  local tmp_dir="$4"
  local output="$5"
  local user_id
  local login
  local credential
  local role
  local index=0
  local route_index
  local model
  local route
  local matches
  local count=0
  local connected=0
  local seen='|'

  user_id="$(json_value "$expected" liteLLMUserId)"
  login="$(json_value "$expected" githubLogin)"
  validate_github_login "$login"
  credential="$(json_value "$expected" copilotCredentialName)"
  request_json GET "$gateway/key/info" "$api_key" '' "$tmp_dir/key-info.json"
  request_json GET "$gateway/user/info" "$api_key" '' "$tmp_dir/info.json"
  [ "$(json_value "$tmp_dir/key-info.json" info.user_id)" = "$user_id" ] &&
    [ "$(json_value "$tmp_dir/info.json" user_info.user_id)" = "$user_id" ] ||
    fail 'the personal key belongs to a different LiteLLM user than the enrollment'
  role="$(json_value "$tmp_dir/info.json" user_info.user_role)"
  [ "$role" = 'internal_user' ] || [ "$role" = 'internal_user_viewer' ] ||
    fail 'a shared administrator key cannot be used for employee enrollment'
  request_json GET "$gateway/credentials/user_connections" "$api_key" '' "$tmp_dir/connections.json"
  while json_array "$tmp_dir/connections.json" "connections.$index" >/dev/null 2>&1; do
    if [ "$(json_value "$tmp_dir/connections.json" "connections.$index.credential_name")" = "$credential" ]; then
      [ "$(json_value "$tmp_dir/connections.json" "connections.$index.provider")" = 'github_copilot' ] &&
        [ "$(json_value "$tmp_dir/connections.json" "connections.$index.connected")" = 'true' ] &&
        [ "$(json_value "$tmp_dir/connections.json" "connections.$index.github_login" | lowercase)" = "$(printf '%s' "$login" | lowercase)" ] ||
        fail 'the LiteLLM Copilot connection does not match the enrolled GitHub account'
      connected=$(( connected + 1 ))
    fi
    index=$(( index + 1 ))
  done
  [ "$connected" -eq 1 ] || fail 'the enrolled per-user GitHub connection is missing or ambiguous'

  request_json GET "$gateway/v1/model/info" "$api_key" '' "$tmp_dir/routes.json"
  request_json GET "$gateway/v1/models" "$api_key" '' "$tmp_dir/models.json"
  /bin/cp "$expected" "$output"
  /usr/bin/plutil -replace models -json '[]' "$output"
  index=0
  while json_array "$tmp_dir/models.json" "data.$index" >/dev/null 2>&1; do
    model="$(json_value "$tmp_dir/models.json" "data.$index.id")"
    index=$(( index + 1 ))
    [[ "$model" =~ ^claude-[a-z0-9.-]+$ ]] || continue
    case "$seen" in *"|$model|"*) continue ;; esac
    route_index=0
    matches=0
    while json_array "$tmp_dir/routes.json" "data.$route_index" >/dev/null 2>&1; do
      route="$(json_value "$tmp_dir/routes.json" "data.$route_index.model_name")"
      if [ "$route" = "$model" ]; then
        [ "$(json_value "$tmp_dir/routes.json" "data.$route_index.litellm_params.model")" = "github_copilot/$model" ] &&
          [ "$(json_value "$tmp_dir/routes.json" "data.$route_index.litellm_params.litellm_credential_name")" = "$credential" ] ||
          fail 'a Claude model has a conflicting provider or GitHub credential route'
        matches=$(( matches + 1 ))
      fi
      route_index=$(( route_index + 1 ))
    done
    [ "$matches" -gt 0 ] || fail 'a Claude model has no approved per-user GitHub Copilot route'
    /usr/bin/plutil -insert "models.$count" -string "$model" "$output"
    seen="${seen}${model}|"
    count=$(( count + 1 ))
  done
  [ "$count" -gt 0 ] || fail 'this personal key has no approved Claude models'
  /usr/bin/plutil -convert json "$output"
  /bin/chmod 0600 "$output"
}

prepare_desktop_config() {
  local gateway="$1"
  local output="$2"
  printf '{"inferenceProvider":"gateway","inferenceGatewayAuthScheme":"bearer","inferenceCredentialKind":"helper-script","modelDiscoveryEnabled":true}\n' >"$output"
  /usr/bin/plutil -insert inferenceGatewayBaseUrl -string "$gateway" "$output"
  /usr/bin/plutil -insert inferenceCredentialHelper -string /bin/bash "$output"
  /usr/bin/plutil -insert inferenceCredentialHelperArgs -json '[]' "$output"
  /usr/bin/plutil -insert inferenceCredentialHelperArgs.0 -string "$INSTALL_PATH" "$output"
  /usr/bin/plutil -insert inferenceCredentialHelperArgs.1 -string token "$output"
  /usr/bin/plutil -convert json "$output"
}

install_enrollment_files() {
  local tmp_dir="$1"
  local index
  local restore
  local sources=("$tmp_dir/verified-profile.json" "$tmp_dir/settings.json" "$tmp_dir/desktop.json")
  local targets=("$PROFILE_PATH" "$SETTINGS_PATH" "$DESKTOP_PATH")
  local existed=()

  for index in 0 1 2; do
    [ ! -L "${targets[$index]}" ] || return 1
    existed[index]=0
    if [ -e "${targets[$index]}" ]; then
      [ -f "${targets[$index]}" ] &&
        [ "$(file_stat '%u' '%u' "${targets[$index]}")" = "$(/usr/bin/id -u)" ] || return 1
      /bin/cp "${targets[$index]}" "$tmp_dir/previous-$index.json" || return 1
      existed[index]=1
    fi
  done
  for index in 0 1 2; do
    if ! /bin/mv "${sources[$index]}" "${targets[$index]}"; then
      for (( restore=0; restore<=index; restore++ )); do
        if [ "${existed[$restore]}" -eq 1 ]; then
          /bin/cp "$tmp_dir/previous-$restore.json" "${targets[$restore]}" ||
            fail 'could not restore the previous local configuration'
        else
          /bin/rm -f "${targets[$restore]}"
        fi
      done
      return 1
    fi
  done
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
  local status
  # Liveness returns a JSON string; readiness also checks PostgreSQL.
  status="$(request_json_status GET "$gateway/health/readiness" '' '' "$output")"
  case "$status" in
    2??)
      valid_json "$output" || fail 'LiteLLM returned invalid health JSON'
      [ "$(json_raw "$output" status || true)" = 'healthy' ] &&
        [ "$(json_raw "$output" db || true)" = 'connected' ] ||
        fail 'LiteLLM is not ready or its database is disconnected'
      ;;
    *)
      fail "LiteLLM health check returned HTTP $status"
      ;;
  esac
}

verify_gateway_access() {
  local gateway="$1"
  local api_key="$2"
  local default_model="$3"
  local tmp_dir="$4"
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

  validate_litellm_key "$api_key"
  request_json GET "$gateway/v1/models" "$api_key" '' "$tmp_dir/models.json"
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
  request_json POST "$gateway/v1/messages" "$api_key" \
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
  source_path="${BASH_SOURCE[0]}"
  [ -f "$source_path" ] || fail 'save this script to a file before running enrollment'
  prepare_private_directories
  [ ! -L "$INSTALL_PATH" ] || fail 'installed helper must not be a symlink'
  if [ -e "$INSTALL_PATH" ]; then
    [ -f "$INSTALL_PATH" ] && [ "$(file_stat '%u' '%u' "$INSTALL_PATH")" = "$(/usr/bin/id -u)" ] ||
      fail 'installed helper must be a regular file owned by the current user'
  fi
  if ! [ "$source_path" -ef "$INSTALL_PATH" ]; then
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
    if [ -n "$(printenv "$key" 2>/dev/null || true)" ]; then
      fail "shell environment setting $key conflicts with the enterprise gateway; run 'unset $key' and retry"
    fi
    if json_raw "$output" "env.$key" >/dev/null 2>&1; then
      setting_conflicts+=("$key")
    fi
  done

  while IFS='=' read -r key desired; do
    existing="$(printenv "$key" 2>/dev/null || true)"
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

refresh_profile() {
  local tmp_dir="$1"
  local gateway
  local api_key
  local output="$tmp_dir/profile.json"

  require_private_file "$PROFILE_PATH" 'enterprise profile'
  valid_json "$PROFILE_PATH" || fail 'enterprise profile is invalid'
  require_direct_profile
  gateway="$(json_value "$PROFILE_PATH" gateway)"
  validate_gateway "$gateway"
  api_key="$(direct_profile_key)"
  verify_litellm_profile "$gateway" "$api_key" "$PROFILE_PATH" "$tmp_dir" "$output"
  /bin/mv "$output" "$PROFILE_PATH"
}

read_litellm_key() {
  local key
  [ -t 0 ] || fail 'run this script in Terminal to enter your personal LiteLLM key'
  printf 'Personal LiteLLM key from your administrator (input hidden): ' >&2
  if ! IFS= read -rs key; then
    printf '\n' >&2
    fail 'enrollment cancelled before using the key'
  fi
  printf '\n' >&2
  validate_litellm_key "$key"
  printf '%s' "$key"
}

open_github() {
  if ! /usr/bin/open 'https://github.com/login/device'; then
    printf 'Could not open the browser. Open https://github.com/login/device manually.\n' >&2
  fi
}

enroll() {
  local gateway="$DEFAULT_GATEWAY"
  local api_key=''
  local tmp_dir
  local response
  local body
  local status
  local interval
  local expires_in
  local deadline
  local service
  local previous_key=''
  local default_model
  local model_count
  local expected_login
  local login
  local user_code
  local no_browser=0
  local next_interval
  local user_id
  local credential='github-copilot-user'
  local expiry
  local models_json='['
  local model
  local seen='|'
  local index=0
  local connected_login=''
  local flow_handle=''

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --gateway)
        [ "$#" -ge 2 ] || fail '--gateway requires a value'
        gateway="${2%/}"
        shift 2
        ;;
      --no-browser) no_browser=1; shift ;;
      *) fail "unknown enrollment option: $1" ;;
    esac
  done

  validate_gateway "$gateway"
  require_macos_tools
  require_claude_version
  preflight_enrollment_settings "$gateway"
  api_key="$(read_litellm_key)"

  tmp_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ccgc-enroll.XXXXXX")"
  TEMP_DIR="$tmp_dir"
  response="$tmp_dir/response.json"
  body="$tmp_dir/body.json"
  trap cleanup_temp EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  verify_gateway_health "$gateway" "$tmp_dir/health.json"
  request_json GET "$gateway/key/info" "$api_key" '' "$tmp_dir/key-info.json"
  request_json GET "$gateway/user/info" "$api_key" '' "$tmp_dir/info.json"
  user_id="$(json_value "$tmp_dir/key-info.json" info.user_id | lowercase)"
  [[ "$user_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    fail 'the LiteLLM key does not belong to an enterprise employee user'
  [ "$(json_value "$tmp_dir/info.json" user_info.user_id)" = "$user_id" ] ||
    fail 'the LiteLLM key and user information do not match'
  case "$(json_value "$tmp_dir/info.json" user_info.user_role)" in
    internal_user|internal_user_viewer) ;;
    *) fail 'the supplied key is not for an employee LiteLLM user' ;;
  esac
  expected_login="$(json_raw "$tmp_dir/info.json" user_info.metadata.github_login 2>/dev/null \
    || json_value "$tmp_dir/info.json" user_info.user_alias)"
  validate_github_login "$expected_login"
  expiry="$(json_raw "$tmp_dir/key-info.json" info.expires 2>/dev/null || true)"
  [ -n "$expiry" ] || fail 'LiteLLM key has no expiry'
  [ "$(expiry_millis "$expiry")" -gt $(( $(/bin/date +%s) * 1000 )) ] ||
    fail 'the supplied LiteLLM key has expired'

  request_json GET "$gateway/v1/models" "$api_key" '' "$tmp_dir/models.json"
  while model="$(json_raw "$tmp_dir/models.json" "data.$index.id" 2>/dev/null)"; do
    index=$(( index + 1 ))
    [[ "$model" =~ ^claude-[a-z0-9.-]+$ ]] || continue
    case "$seen" in *"|$model|"*) continue ;; esac
    seen="${seen}${model}|"
    [ "$models_json" = '[' ] || models_json="${models_json},"
    models_json="${models_json}\"${model}\""
  done
  [ "$models_json" != '[' ] || fail 'LiteLLM has no approved Claude models available to this key'
  models_json="${models_json}]"

  install_self
  request_json GET "$gateway/credentials/user_connections" "$api_key" '' "$tmp_dir/connections.json"
  index=0
  while json_array "$tmp_dir/connections.json" "connections.$index" >/dev/null 2>&1; do
    if [ "$(json_raw "$tmp_dir/connections.json" "connections.$index.credential_name" 2>/dev/null || true)" = "$credential" ] &&
      [ "$(json_raw "$tmp_dir/connections.json" "connections.$index.connected" 2>/dev/null || true)" = 'true' ]; then
      connected_login="$(json_value "$tmp_dir/connections.json" "connections.$index.github_login")"
      break
    fi
    index=$(( index + 1 ))
  done

  if [ -n "$connected_login" ]; then
    [ "$(printf '%s' "$connected_login" | lowercase)" = "$(printf '%s' "$expected_login" | lowercase)" ] ||
      fail 'the LiteLLM user is connected to a different GitHub account; contact IT'
    login="$connected_login"
  else
    request_json POST "$gateway/credentials/$credential/user_connection/start" "$api_key" '' "$response"
    [ "$(json_value "$response" verification_uri)" = 'https://github.com/login/device' ] ||
      fail 'LiteLLM returned an unexpected GitHub authorization URL'
    interval="$(json_value "$response" interval)"
    expires_in="$(json_value "$response" expires_in)"
    [[ "$interval" =~ ^[1-9][0-9]{0,2}$ ]] && [ "$interval" -le 60 ] ||
      fail 'LiteLLM returned an invalid polling interval'
    [[ "$expires_in" =~ ^[1-9][0-9]{0,3}$ ]] && [ "$expires_in" -le 1800 ] ||
      fail 'LiteLLM returned an invalid authorization expiry'
    deadline=$(( $(/bin/date +%s) + expires_in ))
    flow_handle="$(json_value "$response" flow_handle)"
    [[ "$flow_handle" =~ ^(v2:gcm:)?[A-Za-z0-9._:-]+=*$ ]] ||
      fail 'LiteLLM returned an invalid device-flow handle'
    user_code="$(json_value "$response" user_code)"
    [[ "$user_code" =~ ^[A-Z0-9-]{4,32}$ ]] || fail 'LiteLLM returned an invalid GitHub device code'

    printf 'Authorize GitHub Copilot as %s.\n' "$expected_login"
    printf 'Open https://github.com/login/device and enter code: %s\n' \
      "$user_code"
    [ "$no_browser" -eq 1 ] || open_github

    while :; do
      [ "$interval" -le 60 ] && [ $(( $(/bin/date +%s) + interval )) -lt "$deadline" ] ||
        fail 'GitHub authorization expired; rerun setup with your LiteLLM key'
      /bin/sleep "$interval"
      [ "$(/bin/date +%s)" -lt "$deadline" ] ||
        fail 'GitHub authorization expired; rerun setup with your LiteLLM key'
      printf '{"flow_handle":"%s"}\n' "$flow_handle" >"$body"
      request_json POST "$gateway/credentials/$credential/user_connection/poll" "$api_key" "$body" "$response"
      status="$(json_value "$response" status)"
      case "$status" in
        connected)
          login="$(json_value "$response" github_login)"
          break
          ;;
        pending) ;;
        slow_down) interval=$(( interval + 5 )) ;;
        denied) fail 'GitHub authorization was denied' ;;
        expired) fail 'GitHub authorization expired; rerun setup with your LiteLLM key' ;;
        no_copilot_seat) fail 'the GitHub account has no GitHub Copilot entitlement' ;;
        *) fail "LiteLLM returned unsupported connection status: $status" ;;
      esac
      next_interval="$(json_raw "$response" interval 2>/dev/null || printf '%s' "$interval")"
      [[ "$next_interval" =~ ^[1-9][0-9]{0,2}$ ]] && [ "$next_interval" -le 60 ] ||
        fail 'LiteLLM returned an invalid polling interval'
      [ "$next_interval" -le "$interval" ] || interval="$next_interval"
    done
    validate_github_login "$login"
    if [ "$(printf '%s' "$login" | lowercase)" != "$(printf '%s' "$expected_login" | lowercase)" ]; then
      request_json DELETE "$gateway/credentials/$credential/user_connection" "$api_key" '' "$tmp_dir/disconnect.json"
      fail 'the approving GitHub account does not match the employee account; the connection was removed'
    fi
  fi

  printf '{"status":"connected"}\n' >"$response"
  /usr/bin/plutil -insert apiKeyExpiresAt -string "$expiry" "$response"
  /usr/bin/plutil -insert litellmUserId -string "$user_id" "$response"
  /usr/bin/plutil -insert litellmCredentialName -string "$credential" "$response"
  /usr/bin/plutil -insert githubLogin -string "$expected_login" "$response"
  /usr/bin/plutil -insert models -json "$models_json" "$response"
  /usr/bin/plutil -convert json "$response"

  login="$expected_login"
  validate_github_login "$login"
  prepare_litellm_profile "$tmp_dir/profile.json" "$gateway" "$response" "$api_key"
  verify_litellm_profile "$gateway" "$api_key" "$tmp_dir/profile.json" "$tmp_dir" "$tmp_dir/verified-profile.json"
  default_model="$(json_value "$tmp_dir/verified-profile.json" models.0)"
  verify_gateway_access "$gateway" "$api_key" "$default_model" "$tmp_dir"
  prepare_settings "$gateway" "$default_model" "$tmp_dir/settings.json"
  prepare_desktop_config "$gateway" "$tmp_dir/desktop.json"

  service="ccgc.remote.$(json_value "$tmp_dir/verified-profile.json" keychainId)"
  previous_key="$(keychain_get "$service" || true)"
  keychain_set "$service" "$api_key"
  if ! install_enrollment_files "$tmp_dir"; then
    [ "$previous_key" = "$api_key" ] || keychain_delete "$service"
    fail 'could not install the enterprise profile and Claude settings'
  fi

  model_count="$(json_array "$PROFILE_PATH" models | /usr/bin/grep -o '"claude-[^"]*"' | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
  printf 'Enrollment complete for GitHub account %s.\n' "$login"
  printf 'Configured %s approved model(s). The employee key expires at %s.\n' \
    "$model_count" "$expiry"
  if [ -d '/Applications/Claude.app' ]; then
    printf 'Claude Desktop requires separate configuration through Developer > Configure Third-Party Inference; CLI settings do not select its provider.\n'
    printf 'Import %s and relaunch Desktop.\n' "$DESKTOP_PATH"
  fi
  printf 'Restart existing Claude sessions, then run: claude\n'
}

expiry_millis() {
  local normalized
  local seconds
  normalized="$(printf '%s' "$1" | /usr/bin/sed -E 's/\.[0-9]+Z$/Z/; s/Z$/+0000/')"
  seconds="$(/bin/date -j -f '%Y-%m-%dT%H:%M:%S%z' "$normalized" '+%s' 2>/dev/null)" ||
    fail 'gateway returned an invalid credential expiry'
  printf '%s000' "$seconds"
}

token() {
  require_macos_tools
  [ -f "$PROFILE_PATH" ] || fail 'enterprise profile is unavailable; run enrollment first'
  require_private_file "$PROFILE_PATH" 'enterprise profile'
  valid_json "$PROFILE_PATH" || fail 'enterprise profile is invalid'
  require_direct_profile
  direct_profile_key
  printf '\n'
}

models() {
  [ -f "$PROFILE_PATH" ] || fail 'enterprise profile is unavailable; run enrollment first'
  require_macos_tools
  TEMP_DIR="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ccgc-models.XXXXXX")"
  trap cleanup_temp EXIT
  refresh_profile "$TEMP_DIR"
  printf 'GitHub account: %s\n' "$(json_value "$PROFILE_PATH" githubLogin)"
  printf 'Default: %s\n' "$(json_value "$PROFILE_PATH" models.0)"
  printf 'Approved models: %s\n' "$(json_array "$PROFILE_PATH" models)"
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
  prepare_desktop_config "$gateway" "$tmp_dir/desktop.json"
  [ ! -L "$DESKTOP_PATH" ] || fail 'Desktop import file must not be a symlink'
  /bin/mv "$tmp_dir/desktop.json" "$DESKTOP_PATH"
  printf 'Claude Code configuration updated.\n'
  if [ -d '/Applications/Claude.app' ]; then
    printf 'Claude Desktop requires separate configuration through Developer > Configure Third-Party Inference; CLI settings do not select its provider.\n'
  fi
}

doctor() {
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
  require_private_file "$PROFILE_PATH" 'enterprise profile'
  valid_json "$PROFILE_PATH" || fail 'enterprise profile is invalid'
  require_direct_profile
  require_private_file "$INSTALL_PATH" 'installed enterprise helper'
  require_private_file "$SETTINGS_PATH" 'Claude settings'
  valid_json "$SETTINGS_PATH" || fail 'Claude settings are invalid'
  gateway="$(json_value "$PROFILE_PATH" gateway)"
  validate_gateway "$gateway"
  default_model="$(json_value "$PROFILE_PATH" models.0)"
  [[ "$default_model" =~ ^claude-[a-z0-9.-]+$ ]] ||
    fail 'enterprise profile contains an invalid default model'
  expected_model="$(client_model "$default_model")"
  helper="$(installed_helper)"

  for existing in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
    [ -z "$(printenv "$existing" 2>/dev/null || true)" ] ||
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

  tmp_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ccgc-doctor.XXXXXX")"
  TEMP_DIR="$tmp_dir"
  trap cleanup_temp EXIT
  verify_gateway_health "$gateway" "$tmp_dir/health.json"
  api_key="$(direct_profile_key)"
  verify_litellm_profile "$gateway" "$api_key" "$PROFILE_PATH" "$tmp_dir" "$tmp_dir/verified-profile.json"
  [ "$(json_array "$PROFILE_PATH" models)" = "$(json_array "$tmp_dir/verified-profile.json" models)" ] ||
    fail 'enterprise profile models changed; run configure to refresh them'
  verify_gateway_access "$gateway" "$api_key" "$default_model" "$tmp_dir"

  printf 'CCGC doctor passed.\n'
  printf 'Claude Code: %s (minimum supported: %s)\n' \
    "$DETECTED_CLAUDE_VERSION" "$MINIMUM_CLAUDE_VERSION"
  if desktop_version="$(claude_desktop_version)"; then
    printf 'Claude Desktop: %s (installed; gateway routing is not verified by CLI doctor)\n' "$desktop_version"
  else
    printf 'Claude Desktop Code: not installed; CLI profile verified\n'
  fi
  printf 'GitHub account: %s\n' "$(json_value "$PROFILE_PATH" githubLogin)"
  printf 'Default model: %s (%s)\n' "$default_model" "$(model_display_name "$default_model")"
  printf 'Local settings, Keychain, binding, model discovery, output limit, and inference are healthy.\n'
}

main() {
  local command="${1:-enroll}"
  if [ "$#" -gt 0 ]; then shift; fi
  case "$command" in
    enroll|setup) enroll "$@" ;;
    token) [ "$#" -eq 0 ] || fail 'token does not accept options'; token ;;
    models) [ "$#" -eq 0 ] || fail 'models does not accept options'; models ;;
    configure) [ "$#" -eq 0 ] || fail 'configure does not accept options'; configure ;;
    doctor) [ "$#" -eq 0 ] || fail 'doctor does not accept options'; doctor ;;
    help|-h|--help) usage ;;
    *) fail "unknown command: $command" ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
