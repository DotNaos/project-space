package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateClerkDeployCredentialAcceptsWorkingCredential(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if got := request.Header.Get("Authorization"); got != "Bearer working-secret" {
			t.Fatalf("authorization header = %q", got)
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	originalURL := clerkDeployAPIURL
	clerkDeployAPIURL = server.URL
	t.Cleanup(func() { clerkDeployAPIURL = originalURL })

	err := validateClerkDeployCredential(deployOptions{Secrets: map[string]deploySecretValue{
		"CLERK_SECRET_KEY": {Value: "working-secret"},
	}})
	if err != nil {
		t.Fatal(err)
	}
}

func TestValidateClerkDeployCredentialRejectsInvalidCredentialWithoutLeakingDetails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusUnauthorized)
		_, _ = response.Write([]byte("private upstream detail"))
	}))
	defer server.Close()

	originalURL := clerkDeployAPIURL
	clerkDeployAPIURL = server.URL
	t.Cleanup(func() { clerkDeployAPIURL = originalURL })

	err := validateClerkDeployCredential(deployOptions{Secrets: map[string]deploySecretValue{
		"CLERK_SECRET_KEY": {Value: "rejected-secret"},
	}})
	if err == nil || !strings.Contains(err.Error(), "Clerk rejected") {
		t.Fatalf("rejected credential error = %v", err)
	}
	if strings.Contains(err.Error(), "rejected-secret") || strings.Contains(err.Error(), "private upstream detail") {
		t.Fatalf("credential validation leaked private data: %v", err)
	}
}

func TestValidateClerkDeployCredentialRejectsMissingCredential(t *testing.T) {
	err := validateClerkDeployCredential(deployOptions{})
	if err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("missing credential error = %v", err)
	}
}
