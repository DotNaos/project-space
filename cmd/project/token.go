package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const (
	projectTokenVault          = "projects"
	projectTokenPermission     = "read_items"
	projectTokenServiceAccount = "project-ci"
	projectTokenItemTitle      = "project-ci-service-account"
	projectTokenField          = "password"
	projectTokenRef            = "op://projects/project-ci-service-account/password"
	legacyProjectTokenTitle    = "Projects GitHub Actions Service Account"
	legacyProjectTokenRef      = projectServiceAccountTokenRef
)

var (
	lookupExecutable = exec.LookPath
	now              = time.Now
	expiresInPattern = regexp.MustCompile(`^[1-9][0-9]*[smhdw]$`)
)

type tokenCreateOptions struct {
	DryRun    bool
	ExpiresIn string
	JSON      bool
	Yes       bool
}

type tokenCreateResult struct {
	Changed            bool   `json:"changed"`
	DryRun             bool   `json:"dryRun"`
	ExpiresIn          string `json:"expiresIn,omitempty"`
	ItemTitle          string `json:"itemTitle"`
	Message            string `json:"message"`
	Permission         string `json:"permission"`
	ServiceAccountName string `json:"serviceAccountName"`
	Status             string `json:"status"`
	TokenRef           string `json:"tokenRef"`
	Vault              string `json:"vault"`
}

type opItemListEntry struct {
	Title string `json:"title"`
}

type opPasswordItem struct {
	Title    string                `json:"title"`
	Category string                `json:"category"`
	Fields   []opPasswordItemField `json:"fields"`
}

type opPasswordItemField struct {
	ID              string                   `json:"id"`
	Type            string                   `json:"type"`
	Purpose         string                   `json:"purpose,omitempty"`
	Label           string                   `json:"label"`
	PasswordDetails *opPasswordFieldStrength `json:"password_details,omitempty"`
	Value           string                   `json:"value"`
}

type opPasswordFieldStrength struct {
	Strength string `json:"strength"`
}

func newTokenCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "token",
		Short: "Manage the Project 1Password token",
	}
	cmd.AddCommand(newTokenCreateCommand())
	return cmd
}

func newTokenCreateCommand() *cobra.Command {
	options := tokenCreateOptions{}
	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create the Project 1Password service account token",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if options.Yes && options.DryRun {
				return fmt.Errorf("--yes and --dry-run cannot be used together")
			}
			if options.JSON && !options.DryRun && !options.Yes {
				return fmt.Errorf("use --dry-run or --yes with --json")
			}
			if options.ExpiresIn != "" && !expiresInPattern.MatchString(options.ExpiresIn) {
				return fmt.Errorf("--expires-in must look like 1h, 24h, 7d, or 12w")
			}
			result, err := createProjectToken(cmd, options)
			if err != nil {
				return err
			}
			printTokenCreateResult(cmd, result, options.JSON)
			return nil
		},
	}
	cmd.Flags().StringVar(&options.ExpiresIn, "expires-in", "", "create a temporary token with a 1Password expiry, for example 24h")
	cmd.Flags().BoolVar(&options.DryRun, "dry-run", false, "show what would happen without creating a token")
	cmd.Flags().BoolVar(&options.JSON, "json", false, "print machine-readable output")
	cmd.Flags().BoolVarP(&options.Yes, "yes", "y", false, "create the token without prompting")
	return cmd
}

func createProjectToken(cmd *cobra.Command, options tokenCreateOptions) (tokenCreateResult, error) {
	if _, err := lookupExecutable("op"); err != nil {
		return tokenCreateResult{}, errors.New("op is required for project token create")
	}
	if _, err := runCommand("", nil, "op", "vault", "get", projectTokenVault); err != nil {
		return tokenCreateResult{}, fmt.Errorf("read 1Password vault %q: %w", projectTokenVault, err)
	}

	itemTitle := projectTokenItemTitle
	serviceAccountName := projectTokenServiceAccount
	tokenRef := projectTokenRef
	temporary := options.ExpiresIn != ""
	if temporary {
		stamp := now().Format("20060102-150405")
		serviceAccountName = "project-temp-" + stamp
		itemTitle = fmt.Sprintf("project-temp-service-account-%s-%s", stamp, options.ExpiresIn)
		tokenRef = fmt.Sprintf("op://%s/%s/%s", projectTokenVault, itemTitle, projectTokenField)
	}

	result := tokenCreateResult{
		Changed:            true,
		DryRun:             options.DryRun,
		ExpiresIn:          options.ExpiresIn,
		ItemTitle:          itemTitle,
		Permission:         projectTokenPermission,
		ServiceAccountName: serviceAccountName,
		Status:             "planned",
		TokenRef:           tokenRef,
		Vault:              projectTokenVault,
	}

	if !temporary {
		existingTokenRef, exists, err := findExistingProjectTokenRef()
		if err != nil {
			return tokenCreateResult{}, err
		}
		if exists {
			if err := verifyStoredProjectToken(existingTokenRef); err != nil {
				return tokenCreateResult{}, err
			}
			result.Changed = false
			result.TokenRef = existingTokenRef
			result.Status = "ready"
			result.Message = "Project token already exists."
			return result, nil
		}
	}

	if options.DryRun {
		result.Message = "Project token would be created."
		return result, nil
	}

	if !options.Yes {
		fmt.Fprintf(cmd.OutOrStdout(), "Create Project token in 1Password vault %q with %s access? Y/n ", projectTokenVault, projectTokenPermission)
		confirmed, err := confirmTokenCreate(cmd)
		if err != nil {
			return tokenCreateResult{}, err
		}
		if !confirmed {
			result.Changed = false
			result.Status = "canceled"
			result.Message = "Project token creation canceled."
			return result, nil
		}
	}

	token, err := createOnePasswordServiceAccount(serviceAccountName, options.ExpiresIn)
	if err != nil {
		return tokenCreateResult{}, err
	}
	if err := storeProjectToken(itemTitle, token); err != nil {
		return tokenCreateResult{}, fmt.Errorf("store Project token in 1Password: %w. The token was not printed and cannot be recovered; rerun to create a fresh token", err)
	}
	if err := verifyCreatedProjectToken(tokenRef, token); err != nil {
		return tokenCreateResult{}, err
	}

	result.Status = "created"
	result.Message = "Project token created."
	return result, nil
}

func findExistingProjectTokenRef() (string, bool, error) {
	output, err := runCommand("", nil, "op", "item", "list", "--vault", projectTokenVault, "--format", "json")
	if err != nil {
		return "", false, fmt.Errorf("list 1Password items in %q: %w", projectTokenVault, err)
	}
	var entries []opItemListEntry
	if err := json.Unmarshal([]byte(output), &entries); err != nil {
		return "", false, fmt.Errorf("parse 1Password item list: %w", err)
	}
	for _, entry := range entries {
		if entry.Title == projectTokenItemTitle {
			return projectTokenRef, true, nil
		}
	}
	for _, entry := range entries {
		if entry.Title == legacyProjectTokenTitle {
			return legacyProjectTokenRef, true, nil
		}
	}
	return "", false, nil
}

func createOnePasswordServiceAccount(name string, expiresIn string) (string, error) {
	args := []string{"service-account", "create", name, "--vault", projectTokenVault + ":" + projectTokenPermission, "--raw"}
	if expiresIn != "" {
		args = append(args, "--expires-in", expiresIn)
	}
	output, err := runCommand("", nil, "op", args...)
	if err != nil {
		return "", fmt.Errorf("create 1Password service account: %w", err)
	}
	token := strings.TrimSpace(output)
	if token == "" {
		return "", errors.New("1Password service account token was empty")
	}
	return token, nil
}

func storeProjectToken(itemTitle string, token string) error {
	body, err := json.Marshal(opPasswordItem{
		Title:    itemTitle,
		Category: "PASSWORD",
		Fields: []opPasswordItemField{
			{
				ID:      "password",
				Type:    "CONCEALED",
				Purpose: "PASSWORD",
				Label:   projectTokenField,
				PasswordDetails: &opPasswordFieldStrength{
					Strength: "TERRIBLE",
				},
				Value: token,
			},
			{
				ID:      "notesPlain",
				Type:    "STRING",
				Purpose: "NOTES",
				Label:   "notesPlain",
				Value:   "Created by project token create.",
			},
		},
	})
	if err != nil {
		return err
	}
	if _, err := runCommand("", body, "op", "item", "create", "--vault", projectTokenVault, "-"); err != nil {
		return err
	}
	return nil
}

func verifyCreatedProjectToken(tokenRef string, expected string) error {
	output, err := runCommand("", nil, "op", "read", tokenRef)
	if err != nil {
		return fmt.Errorf("verify stored Project token: %w", err)
	}
	if strings.TrimSpace(output) != expected {
		return errors.New("stored Project token did not match the created token")
	}
	return nil
}

func verifyStoredProjectToken(refs ...string) error {
	var lastErr error
	for _, ref := range refs {
		output, err := runCommand("", nil, "op", "read", ref)
		if err == nil && strings.TrimSpace(output) != "" {
			return nil
		}
		if err != nil {
			lastErr = err
		}
	}
	if lastErr != nil {
		return fmt.Errorf("verify stored Project token: %w", lastErr)
	}
	return errors.New("stored Project token was empty")
}

func confirmTokenCreate(cmd *cobra.Command) (bool, error) {
	reader := bufio.NewReader(cmd.InOrStdin())
	answer, err := reader.ReadString('\n')
	if err != nil && answer == "" {
		return false, fmt.Errorf("confirmation required; rerun with --yes or --dry-run")
	}
	answer = strings.ToLower(strings.TrimSpace(answer))
	return answer == "" || answer == "y" || answer == "yes", nil
}

func printTokenCreateResult(cmd *cobra.Command, result tokenCreateResult, asJSON bool) {
	if asJSON {
		body, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			fmt.Fprintf(cmd.OutOrStdout(), "{\"status\":\"error\",\"message\":%q}\n", err.Error())
			return
		}
		fmt.Fprintln(cmd.OutOrStdout(), string(body))
		return
	}

	fmt.Fprintln(cmd.OutOrStdout(), result.Message)
	fmt.Fprintf(cmd.OutOrStdout(), "Service account: %s\n", result.ServiceAccountName)
	fmt.Fprintf(cmd.OutOrStdout(), "Vault: %s\n", result.Vault)
	fmt.Fprintf(cmd.OutOrStdout(), "Permission: %s\n", result.Permission)
	fmt.Fprintf(cmd.OutOrStdout(), "Token reference: %s\n", result.TokenRef)
	if result.ExpiresIn != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Expires in: %s\n", result.ExpiresIn)
	}
}
