package main

import "testing"

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
