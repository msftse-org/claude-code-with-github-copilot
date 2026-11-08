package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCredentialIdentifiersAreStableAndSeparate(t *testing.T) {
	gateway := "https://broker.example"
	admission := profileCredentialID(gateway)
	apiKey := apiKeyCredentialID(gateway)
	if len(admission) != 64 || len(apiKey) != 64 {
		t.Fatal("credential identifiers must be SHA-256 hex digests")
	}
	if admission == apiKey {
		t.Fatal("employee API key and admission must use separate credential identifiers")
	}
}

func TestEnrollmentCredentialValidation(t *testing.T) {
	if !validEnrollmentCode("CCGC-abcdefghijklmnopqrstuvwx") {
		t.Fatal("expected valid enrollment code")
	}
	if validEnrollmentCode("CCGC-abcdefghijklmnopqrstuvw!") {
		t.Fatal("accepted invalid enrollment code")
	}
	if !validAPIKey("ccgc_sk_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ") {
		t.Fatal("expected valid employee API key")
	}
	if validAPIKey("ccgc_sk_short") {
		t.Fatal("accepted invalid employee API key")
	}
	if !validAdmission("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef") {
		t.Fatal("expected valid admission token")
	}
	if !validLiteLLMKey("sk-abcdefghijklmnopqrstuvwxyz") {
		t.Fatal("expected valid LiteLLM virtual key")
	}
	if validLiteLLMKey("sk-short") {
		t.Fatal("accepted invalid LiteLLM virtual key")
	}
}

func TestReadPrivateAPIKeyRequiresPrivateRegularFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "key.json")
	if err := os.WriteFile(path, []byte(`{"apiKey":"sk-abcdefghijklmnopqrstuvwxyz"}`), 0600); err != nil {
		t.Fatal(err)
	}
	key, err := readPrivateAPIKey(path)
	if err != nil || key != "sk-abcdefghijklmnopqrstuvwxyz" {
		t.Fatalf("unexpected key result %q: %v", key, err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readPrivateAPIKey(path); err == nil {
		t.Fatal("accepted an API-key file readable by other users")
	}
}

func TestDirectKeyProfileIsValidWithoutEnterpriseIdentity(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	expected := profile{
		Gateway:    "https://litellm.example",
		AuthMethod: "litellmKey",
		Models:     []string{"claude-sonnet-5.5"},
	}

	if err := writeProfile(expected); err != nil {
		t.Fatal(err)
	}
	actual, err := readProfile()
	if err != nil {
		t.Fatal(err)
	}
	if actual.Gateway != expected.Gateway || actual.AuthMethod != expected.AuthMethod {
		t.Fatalf("unexpected direct-key profile: %#v", actual)
	}
}

func TestClientModelPreservesGatewayModelID(t *testing.T) {
	if actual := clientModel("claude-sonnet-5.5"); actual != "claude-sonnet-5.5" {
		t.Fatalf("changed canonical gateway model ID to %q", actual)
	}
}

func TestGatewayValidation(t *testing.T) {
	actual, err := normalizeGateway("https://broker.example/")
	if err != nil || actual != "https://broker.example" {
		t.Fatalf("unexpected normalized gateway %q: %v", actual, err)
	}
	for _, value := range []string{
		"http://broker.example",
		"https://user:password@broker.example",
		"https://broker.example/?secret=value",
		"https://broker.example/../admin",
	} {
		if _, err := normalizeGateway(value); err == nil {
			t.Fatalf("accepted invalid gateway %q", value)
		}
	}
}

func TestEnrollmentIdentityMustMatchBinding(t *testing.T) {
	enrollment := enrollmentResult{
		TenantID:        "tenant",
		ObjectID:        "object",
		GitHubLogin:     "Developer",
		GitHubAccountID: 42,
		Models:          []string{"claude-sonnet-4-5"},
	}
	info := infoResult{
		TenantID:        "tenant",
		ObjectID:        "object",
		GitHubLogin:     "developer",
		GitHubAccountID: 42,
		Models:          []string{"claude-sonnet-4-5"},
	}
	if !sameEnrollmentIdentity(enrollment, info) {
		t.Fatal("matching enrollment identity was rejected")
	}
	info.GitHubAccountID = 43
	if sameEnrollmentIdentity(enrollment, info) {
		t.Fatal("different immutable GitHub account ID was accepted")
	}
}
