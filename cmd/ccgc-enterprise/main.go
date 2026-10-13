package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const version = "0.2.0-alpha.1"

type profile struct {
	Gateway         string   `json:"gateway"`
	AuthMethod      string   `json:"authMethod"`
	TenantID        string   `json:"tenantId"`
	ObjectID        string   `json:"objectId"`
	GitHubLogin     string   `json:"githubLogin"`
	GitHubAccountID int64    `json:"githubAccountId"`
	Models          []string `json:"models"`
	BindingRevision int64    `json:"bindingRevision"`
	Grant           *grant   `json:"grant,omitempty"`
}

type grant struct {
	ID      string `json:"id"`
	Expires int64  `json:"expires"`
}

type enrollmentResult struct {
	Status          string   `json:"status"`
	VerificationURI string   `json:"verificationUri"`
	UserCode        string   `json:"userCode"`
	ExpiresIn       int      `json:"expiresIn"`
	Interval        int      `json:"interval"`
	GitHubLogin     string   `json:"githubLogin"`
	GitHubAccountID int64    `json:"githubAccountId"`
	TenantID        string   `json:"tenantId"`
	ObjectID        string   `json:"objectId"`
	Models          []string `json:"models"`
	APIKey          string   `json:"apiKey"`
	APIKeyID        string   `json:"apiKeyId"`
	APIKeyExpiresAt string   `json:"apiKeyExpiresAt"`
}

type infoResult struct {
	TenantID        string   `json:"tenantId"`
	ObjectID        string   `json:"objectId"`
	GitHubLogin     string   `json:"githubLogin"`
	GitHubAccountID int64    `json:"githubAccountId"`
	Models          []string `json:"models"`
	BindingRevision int64    `json:"bindingRevision"`
}

type admissionResult struct {
	ID        string `json:"id"`
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
}

type apiError struct {
	Status int
}

func (e *apiError) Error() string {
	return fmt.Sprintf("enterprise gateway returned HTTP %d", e.Status)
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		printHelp()
		return nil
	}
	switch args[0] {
	case "enroll":
		return enroll(args[1:])
	case "token":
		return printToken(args[1:])
	case "models":
		return printModels(args[1:])
	case "configure":
		return configureCommand(args[1:])
	case "version", "--version":
		fmt.Println(version)
		return nil
	case "help", "-h", "--help":
		printHelp()
		return nil
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func printHelp() {
	fmt.Println(`ccgc-enterprise - self-service Claude Code enterprise enrollment

Usage:
  ccgc-enterprise enroll --gateway HTTPS_URL --code CCGC-CODE
  ccgc-enterprise token
  ccgc-enterprise models
  ccgc-enterprise configure
  ccgc-enterprise version

The enroll command opens GitHub device authorization, verifies the assigned
GitHub identity, stores the 30-day employee key in the operating-system
credential store, and configures Claude Code. The token command is Claude's
apiKeyHelper and prints only a short-lived bounded admission token.`)
}

func enroll(args []string) error {
	flags := flag.NewFlagSet("enroll", flag.ContinueOnError)
	gatewayFlag := flags.String("gateway", "", "enterprise gateway HTTPS URL")
	code := flags.String("code", "", "single-use enrollment code")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *gatewayFlag == "" || *code == "" {
		return errors.New("enroll requires --gateway and --code")
	}
	gateway, err := normalizeGateway(*gatewayFlag)
	if err != nil {
		return err
	}
	if !validEnrollmentCode(*code) {
		return errors.New("invalid enrollment code")
	}

	var result enrollmentResult
	if err := requestJSON(http.MethodPost, gateway+"/ccgc/enroll/start", "", map[string]string{"code": *code}, &result); err != nil {
		return err
	}
	if result.Status == "authorization_required" {
		if result.VerificationURI != "https://github.com/login/device" || result.UserCode == "" || result.Interval < 1 || result.ExpiresIn < 1 {
			return errors.New("gateway returned an invalid GitHub authorization flow")
		}
		fmt.Printf("Authorize the assigned GitHub account %s.\n", result.GitHubLogin)
		fmt.Printf("Open %s and enter code: %s\n", result.VerificationURI, result.UserCode)
		if err := openBrowser(result.VerificationURI); err != nil {
			fmt.Fprintf(os.Stderr, "Browser was not opened automatically: %v\n", err)
		}
		deadline := time.Now().Add(time.Duration(result.ExpiresIn) * time.Second)
		interval := time.Duration(result.Interval) * time.Second
		for {
			if time.Now().Add(interval).After(deadline) {
				return errors.New("GitHub authorization expired; run enroll again")
			}
			time.Sleep(interval)
			result = enrollmentResult{}
			if err := requestJSON(http.MethodPost, gateway+"/ccgc/enroll/poll", "", map[string]string{"code": *code}, &result); err != nil {
				return err
			}
			switch result.Status {
			case "completed":
				goto completed
			case "pending", "finalizing":
			case "slow_down":
				interval += 5 * time.Second
			case "denied":
				return errors.New("GitHub authorization was denied")
			case "expired":
				return errors.New("GitHub authorization expired; run enroll again")
			case "no_copilot_seat":
				return errors.New("the authorized GitHub account has no GitHub Copilot entitlement")
			default:
				return fmt.Errorf("gateway returned unsupported enrollment status %q", result.Status)
			}
		}
	}

completed:
	if result.Status != "completed" || !validAPIKey(result.APIKey) {
		return fmt.Errorf("gateway returned incomplete enrollment status %q", result.Status)
	}
	if err := secureSet(apiKeyCredentialID(gateway), result.APIKey); err != nil {
		return fmt.Errorf("store employee credential: %w", err)
	}
	saved := false
	defer func() {
		if !saved {
			_ = secureDelete(apiKeyCredentialID(gateway))
		}
	}()

	var info infoResult
	if err := requestJSON(http.MethodGet, gateway+"/ccgc/enterprise/info", result.APIKey, nil, &info); err != nil {
		return fmt.Errorf("verify enterprise binding: %w", err)
	}
	if !sameEnrollmentIdentity(result, info) {
		return errors.New("enterprise binding does not match the verified enrollment identity")
	}
	next := profile{
		Gateway:         gateway,
		AuthMethod:      "apiKey",
		TenantID:        info.TenantID,
		ObjectID:        info.ObjectID,
		GitHubLogin:     info.GitHubLogin,
		GitHubAccountID: info.GitHubAccountID,
		Models:          info.Models,
		BindingRevision: info.BindingRevision,
	}
	if err := writeProfile(next); err != nil {
		return err
	}
	saved = true
	if err := configure(next); err != nil {
		return err
	}
	if err := requestJSON(http.MethodPost, gateway+"/ccgc/enroll/complete", "", map[string]string{"code": *code}, &map[string]any{}); err != nil {
		return fmt.Errorf("local setup succeeded but enrollment acknowledgment failed; rerun the same command: %w", err)
	}
	fmt.Printf("Enrollment complete for GitHub account %s (%d).\n", info.GitHubLogin, info.GitHubAccountID)
	fmt.Printf("Configured %d approved model(s). The employee key expires at %s.\n", len(info.Models), result.APIKeyExpiresAt)
	return nil
}

func printToken(args []string) error {
	if len(args) != 0 {
		return errors.New("token does not accept options")
	}
	current, err := readProfile()
	if err != nil {
		return err
	}
	admissionID := profileCredentialID(current.Gateway)
	if current.Grant != nil && current.Grant.Expires > time.Now().Add(5*time.Minute).UnixMilli() {
		token, getErr := secureGet(admissionID)
		if getErr == nil && validAdmission(token) {
			fmt.Println(token)
			return nil
		}
	}
	apiKey, err := secureGet(apiKeyCredentialID(current.Gateway))
	if err != nil {
		return fmt.Errorf("employee credential unavailable: %w", err)
	}
	if !validAPIKey(apiKey) {
		return errors.New("stored employee credential is invalid")
	}
	var issued admissionResult
	if err := requestJSON(http.MethodPost, current.Gateway+"/ccgc/enterprise/admissions", apiKey, map[string]int{
		"ttlSeconds":  28800,
		"maxAttempts": 50,
	}, &issued); err != nil {
		return err
	}
	expires, err := time.Parse(time.RFC3339Nano, issued.ExpiresAt)
	if err != nil || !validAdmission(issued.Token) || issued.ID == "" {
		return errors.New("gateway returned an invalid admission")
	}
	if err := secureSet(admissionID, issued.Token); err != nil {
		return fmt.Errorf("store admission: %w", err)
	}
	current.Grant = &grant{ID: issued.ID, Expires: expires.UnixMilli()}
	if err := writeProfile(current); err != nil {
		_ = secureDelete(admissionID)
		return err
	}
	fmt.Println(issued.Token)
	return nil
}

func printModels(args []string) error {
	if len(args) != 0 {
		return errors.New("models does not accept options")
	}
	current, err := readProfile()
	if err != nil {
		return err
	}
	return printJSON(map[string]any{
		"default":         current.Models[0],
		"models":          current.Models,
		"bindingRevision": current.BindingRevision,
	})
}

func configureCommand(args []string) error {
	if len(args) != 0 {
		return errors.New("configure does not accept options")
	}
	current, err := readProfile()
	if err != nil {
		return err
	}
	if err := configure(current); err != nil {
		return err
	}
	fmt.Println("Claude Code configuration updated.")
	return nil
}

func requestJSON(method, endpoint, bearer string, input any, output any) error {
	var body io.Reader
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	client := &http.Client{
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return &apiError{Status: response.StatusCode}
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1024*1024))
	if err := decoder.Decode(output); err != nil {
		return errors.New("gateway returned invalid JSON")
	}
	return nil
}

func normalizeGateway(value string) (string, error) {
	if strings.ContainsAny(value, "\\% \t\r\n") || strings.Contains(value, "..") {
		return "", errors.New("gateway URL contains forbidden characters")
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" || strings.Contains(parsed.Path, "//") {
		return "", errors.New("gateway must be an absolute HTTPS URL without credentials, query, fragment, or traversal")
	}
	return strings.TrimSuffix(parsed.String(), "/"), nil
}

func sameEnrollmentIdentity(enrollment enrollmentResult, info infoResult) bool {
	return enrollment.TenantID == info.TenantID &&
		enrollment.ObjectID == info.ObjectID &&
		strings.EqualFold(enrollment.GitHubLogin, info.GitHubLogin) &&
		enrollment.GitHubAccountID == info.GitHubAccountID &&
		strings.Join(enrollment.Models, "\n") == strings.Join(info.Models, "\n")
}

func validEnrollmentCode(value string) bool {
	if len(value) != 29 || !strings.HasPrefix(value, "CCGC-") {
		return false
	}
	return tokenAlphabet(value[5:])
}

func validAPIKey(value string) bool {
	return len(value) == 51 && strings.HasPrefix(value, "ccgc_sk_") && tokenAlphabet(value[8:])
}

func validAdmission(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}

func tokenAlphabet(value string) bool {
	for _, character := range value {
		if !(character >= 'a' && character <= 'z') &&
			!(character >= 'A' && character <= 'Z') &&
			!(character >= '0' && character <= '9') &&
			character != '_' && character != '-' {
			return false
		}
	}
	return true
}

func profileCredentialID(gateway string) string {
	sum := sha256.Sum256([]byte(gateway))
	return hex.EncodeToString(sum[:])
}

func apiKeyCredentialID(gateway string) string {
	sum := sha256.Sum256([]byte("enterprise-api-key\n" + gateway))
	return hex.EncodeToString(sum[:])
}

func statePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "ccgc", "enterprise", "profile.json"), nil
}

func readProfile() (profile, error) {
	var result profile
	path, err := statePath()
	if err != nil {
		return result, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return result, fmt.Errorf("read enterprise profile: %w", err)
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return result, errors.New("enterprise profile is invalid")
	}
	if result.AuthMethod != "apiKey" || result.Gateway == "" || len(result.Models) == 0 {
		return result, errors.New("enterprise profile is incomplete")
	}
	return result, nil
}

func writeProfile(value profile) error {
	path, err := statePath()
	if err != nil {
		return err
	}
	return writePrivateJSON(path, value)
}

func writePrivateJSON(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	temporary := path + "." + strconv.FormatInt(time.Now().UnixNano(), 10) + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		_ = file.Close()
		if !ok {
			_ = os.Remove(temporary)
		}
	}()
	if _, err := file.Write(raw); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		return err
	}
	ok = true
	return nil
}

func configure(value profile) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return err
	}
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	current := map[string]any{}
	if raw, readErr := os.ReadFile(settingsPath); readErr == nil {
		if err := json.Unmarshal(raw, &current); err != nil {
			return errors.New("existing Claude settings are invalid JSON")
		}
	} else if !os.IsNotExist(readErr) {
		return readErr
	}
	expectedHelper := shellQuote(executable) + " token"
	if existing, ok := current["apiKeyHelper"].(string); ok && existing != expectedHelper {
		return errors.New("an unrelated Claude credential helper is already configured")
	}
	env, _ := current["env"].(map[string]any)
	if env == nil {
		env = map[string]any{}
	}
	expected := map[string]string{
		"ANTHROPIC_BASE_URL":                         value.Gateway,
		"ANTHROPIC_DEFAULT_MODEL":                    clientModel(value.Models[0]),
		"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
		"CLAUDE_CODE_API_KEY_HELPER_TTL_MS":          "60000",
		"CLAUDE_CODE_AUTO_MODE_SERVER":               "0",
	}
	for _, item := range os.Environ() {
		key, currentValue, found := strings.Cut(item, "=")
		if !found || currentValue == "" || !controlsRouting(key) {
			continue
		}
		if desired, allowed := expected[key]; !allowed || desired != currentValue {
			return fmt.Errorf("shell environment setting %s conflicts with the enterprise gateway", key)
		}
	}
	for key, currentValue := range env {
		if !controlsRouting(key) {
			continue
		}
		if desired, allowed := expected[key]; !allowed || currentValue != desired {
			return fmt.Errorf("existing Claude setting %s conflicts with the enterprise gateway", key)
		}
	}
	for key, desired := range expected {
		env[key] = desired
	}
	permissions, _ := current["permissions"].(map[string]any)
	if permissions == nil {
		permissions = map[string]any{}
	}
	if existing, ok := permissions["defaultMode"]; ok && existing != "manual" {
		return errors.New("existing Claude permission default conflicts with enterprise manual mode")
	}
	permissions["defaultMode"] = "manual"
	current["env"] = env
	current["permissions"] = permissions
	current["apiKeyHelper"] = expectedHelper
	return writePrivateJSON(settingsPath, current)
}

func controlsRouting(key string) bool {
	if strings.HasPrefix(key, "ANTHROPIC_") || key == "CLAUDE_CONFIG_DIR" {
		return true
	}
	for _, prefix := range []string{
		"CLAUDE_CODE_USE_",
		"CLAUDE_CODE_OAUTH",
		"CLAUDE_CODE_PROVIDER",
		"CLAUDE_CODE_API_KEY",
		"CLAUDE_CODE_CUSTOM",
		"CLAUDE_CODE_MODEL",
	} {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}

func clientModel(model string) string {
	if model == "claude-haiku-4.5" {
		return "claude-haiku-4-5-20251001"
	}
	return strings.ReplaceAll(model, ".", "-")
}

func shellQuote(value string) string {
	if runtime.GOOS == "windows" {
		return strconv.Quote(value)
	}
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func openBrowser(target string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("/usr/bin/open", target)
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		command = exec.Command("xdg-open", target)
	}
	return command.Start()
}

func printJSON(value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(raw))
	return nil
}
