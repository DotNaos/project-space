package main

import (
	"fmt"
	"net/http"
	"strings"
	"time"
)

var clerkDeployHTTPClient = &http.Client{Timeout: 10 * time.Second}
var clerkDeployAPIURL = "https://api.clerk.com/v1/users?limit=1"

func validateClerkDeployCredential(options deployOptions) error {
	secret := strings.TrimSpace(options.Secrets["CLERK_SECRET_KEY"].Value)
	if secret == "" {
		return fmt.Errorf("Clerk deployment credential is missing")
	}

	request, err := http.NewRequest(http.MethodGet, clerkDeployAPIURL, nil)
	if err != nil {
		return fmt.Errorf("prepare Clerk deployment credential check: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("User-Agent", "project-space-deploy-preflight")

	response, err := clerkDeployHTTPClient.Do(request)
	if err != nil {
		return fmt.Errorf("Clerk deployment credential could not be verified")
	}
	defer response.Body.Close()

	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return fmt.Errorf("Clerk rejected the deployment credential")
	}
	return fmt.Errorf("Clerk deployment credential could not be verified")
}
