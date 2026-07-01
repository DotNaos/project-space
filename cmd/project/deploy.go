package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

type deployOptions struct {
	Host                             string
	RemotePath                       string
	Branch                           string
	ProjectDomain                    string
	APIDomain                        string
	AcmeEmail                        string
	GitHubToken                      string
	GitHubTokenSource                string
	GitHubOAuthClientID              string
	GitHubOAuthClientIDSource        string
	ClerkPublishableKey              string
	ClerkPublishableKeySource        string
	ClerkSecretKey                   string
	ClerkSecretKeySource             string
	ConnectorRegistrationToken       string
	ConnectorRegistrationTokenSource string
	DryRun                           bool
}

type deployProject struct {
	Name       string
	RemoteURL  string
	RemoteRef  string
	RemotePath string
	Branch     string
	WebURL     string
	APIURL     string
	Steps      []string
	Status     string
}

type deployConfig struct {
	Host      string `yaml:"host"`
	Path      string `yaml:"path"`
	Branch    string `yaml:"branch"`
	Domain    string `yaml:"domain"`
	APIDomain string `yaml:"apiDomain"`
	Email     string `yaml:"email"`
}

type deployCandidate struct {
	Value  string
	Source string
}

const (
	deployGitHubTokenRef                = "op://projects/GitHub Personal Access Token/token"
	deployGitHubOAuthClientIDRef        = "op://projects/GitHub OAuth App/client_id"
	deployClerkPublishableKeyRef        = "op://projects/clerk-project/publishable_key"
	deployClerkSecretKeyRef             = "op://projects/clerk-project/secret_key"
	deployConnectorRegistrationTokenRef = "op://projects/Project Space Connector Registration Token/password"
)

func newDeployCommand() *cobra.Command {
	options := deployOptions{}
	cmd := &cobra.Command{
		Use:               "deploy [directory]",
		Short:             "Deploy this project to the VPS",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			target := "."
			if len(args) == 1 {
				target = args[0]
			}
			resolved, err := filepath.Abs(target)
			if err != nil {
				return err
			}
			result, err := deployProjectToVPS(cmd, resolved, options)
			if err != nil {
				return err
			}
			printDeployResult(cmd, result, options.DryRun)
			return nil
		},
	}
	addDeployFlags(cmd, &options)
	cmd.AddCommand(newDeployStatusCommand())
	return cmd
}

func newDeployStatusCommand() *cobra.Command {
	options := deployOptions{}
	cmd := &cobra.Command{
		Use:               "status [directory]",
		Short:             "Inspect deployment status without changing the VPS",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			target := "."
			if len(args) == 1 {
				target = args[0]
			}
			resolved, err := filepath.Abs(target)
			if err != nil {
				return err
			}
			result, err := deployProjectStatus(cmd, resolved, options)
			if err != nil {
				return err
			}
			printDeployStatus(cmd, result)
			return nil
		},
	}
	addDeployFlags(cmd, &options)
	must(cmd.Flags().MarkHidden("dry-run"))
	return cmd
}

func addDeployFlags(cmd *cobra.Command, options *deployOptions) {
	cmd.Flags().StringVar(&options.Host, "host", "", "SSH host")
	cmd.Flags().StringVar(&options.RemotePath, "path", "", "remote project directory")
	cmd.Flags().StringVar(&options.Branch, "branch", "", "git branch to deploy")
	cmd.Flags().StringVar(&options.ProjectDomain, "domain", "", "project domain")
	cmd.Flags().StringVar(&options.APIDomain, "api-domain", "", "project API domain")
	cmd.Flags().StringVar(&options.AcmeEmail, "email", "", "Traefik ACME email")
	cmd.Flags().BoolVar(&options.DryRun, "dry-run", false, "print planned remote actions without changing the VPS")
	must(cmd.RegisterFlagCompletionFunc("path", directoryCompletion))
}

func deployProjectToVPS(cmd *cobra.Command, projectRoot string, options deployOptions) (deployProject, error) {
	project, options, err := resolveDeployProject(cmd, projectRoot, options, true)
	if err != nil {
		return deployProject{}, err
	}
	steps := deploySteps(project, options)
	project.Steps = steps
	if options.DryRun {
		return project, nil
	}
	for _, step := range steps {
		if step == composeUpStep(project, options) || step == composeStatusStep(project, options) {
			if _, err := runRemoteScript(options.Host, deployComposeScript(project, options, strings.Contains(step, " up "))); err != nil {
				return deployProject{}, fmt.Errorf("remote deploy step failed: %w", err)
			}
			continue
		}

		if _, err := runCommand("", nil, "ssh", options.Host, step); err != nil {
			return deployProject{}, fmt.Errorf("remote deploy step failed: %w", err)
		}
	}
	return project, nil
}

func deployProjectStatus(cmd *cobra.Command, projectRoot string, options deployOptions) (deployProject, error) {
	project, options, err := resolveDeployProject(cmd, projectRoot, options, false)
	if err != nil {
		return deployProject{}, err
	}
	if options.ProjectDomain == "" {
		options.ProjectDomain = "status.local"
	}
	if options.APIDomain == "" {
		options.APIDomain = "status-api.local"
	}
	env := deployStatusEnv(options)
	statusScript := strings.Join([]string{
		"set -e",
		"echo SSH ok",
		"docker --version",
		"docker compose version",
		"if docker info >/dev/null 2>&1; then echo docker api ok; else echo docker api unavailable; fi",
		"if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx private-platform-traefik; then echo traefik running; else echo traefik missing; fi",
		"if docker network inspect traefik-public >/dev/null 2>&1; then echo traefik-public network ok; else echo traefik-public network missing; fi",
		fmt.Sprintf("if [ -d %s/.git ]; then echo repo present; else echo repo missing; fi", shellQuote(project.RemotePath)),
		fmt.Sprintf("if [ -d %s/.git ]; then cd %s && %s docker compose -f deploy/compose.yml -f deploy/ingress.labels.yml ps 2>/dev/null || echo app status unavailable; else true; fi", shellQuote(project.RemotePath), shellQuote(project.RemotePath), env),
	}, "\n")
	output, err := runCommand("", nil, "ssh", options.Host, statusScript)
	if err != nil {
		return deployProject{}, fmt.Errorf("read deployment status: %w", err)
	}
	project.Status = strings.TrimSpace(output)
	return project, nil
}

func resolveDeployProject(cmd *cobra.Command, projectRoot string, options deployOptions, requireRuntimeValues bool) (deployProject, deployOptions, error) {
	if _, err := os.Stat(filepath.Join(projectRoot, "deploy", "compose.yml")); err != nil {
		return deployProject{}, options, fmt.Errorf("deploy/compose.yml is required: %w", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, "deploy", "ingress.labels.yml")); err != nil {
		return deployProject{}, options, fmt.Errorf("deploy/ingress.labels.yml is required: %w", err)
	}
	config, err := readDeployConfig(projectRoot)
	if err != nil {
		return deployProject{}, options, err
	}
	input := bufio.NewReader(cmd.InOrStdin())

	remoteURL, err := gitRemoteURL(projectRoot)
	if err != nil {
		return deployProject{}, options, err
	}
	repoRef, err := githubRepositoryRef(remoteURL)
	if err != nil {
		return deployProject{}, options, err
	}
	projectName := strings.TrimPrefix(repoRef[strings.LastIndex(repoRef, "/"):], "/")
	currentBranch, _ := gitCurrentBranch(projectRoot)

	options.Host, err = resolveDeployValue(cmd, input, "deploy host", "host", options.Host, []deployCandidate{
		configCandidate(config.Host, "deploy/deploy.yaml"),
		firstEnvCandidate("PROJECT_DEPLOY_HOST", "DEPLOY_HOST"),
		{Value: "deploy@100.84.238.75", Source: "standard VPS deploy host"},
	}, true)
	if err != nil {
		return deployProject{}, options, err
	}
	options.RemotePath, err = resolveDeployValue(cmd, input, "remote path", "path", options.RemotePath, []deployCandidate{
		configCandidate(config.Path, "deploy/deploy.yaml"),
		firstEnvCandidate("PROJECT_DEPLOY_PATH", "DEPLOY_PATH"),
		{Value: "/opt/platform/apps/" + projectName, Source: "project name"},
	}, true)
	if err != nil {
		return deployProject{}, options, err
	}
	options.Branch, err = resolveDeployValue(cmd, input, "git branch", "branch", options.Branch, []deployCandidate{
		configCandidate(config.Branch, "deploy/deploy.yaml"),
		configCandidate(currentBranch, "current Git checkout"),
		{Value: "main", Source: "standard branch"},
	}, true)
	if err != nil {
		return deployProject{}, options, err
	}
	options.ProjectDomain, err = resolveDeployValue(cmd, input, "project domain", "domain", options.ProjectDomain, []deployCandidate{
		configCandidate(config.Domain, "deploy/deploy.yaml"),
		firstEnvCandidate("PROJECT_DOMAIN", "PROJECT_DEPLOY_DOMAIN"),
	}, requireRuntimeValues)
	if err != nil {
		return deployProject{}, options, err
	}
	options.APIDomain, err = resolveDeployValue(cmd, input, "project API domain", "api-domain", options.APIDomain, []deployCandidate{
		configCandidate(config.APIDomain, "deploy/deploy.yaml"),
		firstEnvCandidate("PROJECT_API_DOMAIN", "PROJECT_DEPLOY_API_DOMAIN"),
		configCandidate(defaultAPIDomain(options.ProjectDomain), "project domain"),
	}, requireRuntimeValues)
	if err != nil {
		return deployProject{}, options, err
	}
	options.AcmeEmail, _ = resolveDeployValue(cmd, input, "ACME email", "email", options.AcmeEmail, []deployCandidate{
		configCandidate(config.Email, "deploy/deploy.yaml"),
		firstEnvCandidate("TRAEFIK_ACME_EMAIL", "PROJECT_DEPLOY_ACME_EMAIL"),
	}, false)
	if requireRuntimeValues {
		options.GitHubToken, options.GitHubTokenSource, err = resolveDeploySecretValue(
			"GitHub token",
			[]string{"GITHUB_TOKEN"},
			deployGitHubTokenRef,
			true,
		)
		if err != nil {
			return deployProject{}, options, err
		}
		options.GitHubOAuthClientID, options.GitHubOAuthClientIDSource, err = resolveDeploySecretValue(
			"GitHub OAuth client ID",
			[]string{"GITHUB_OAUTH_CLIENT_ID", "PROJECT_SPACE_GITHUB_CLIENT_ID", "GITHUB_CLIENT_ID"},
			deployGitHubOAuthClientIDRef,
			false,
		)
		if err != nil {
			return deployProject{}, options, err
		}
		options.ClerkPublishableKey, options.ClerkPublishableKeySource, err = resolveDeploySecretValue(
			"Clerk publishable key",
			[]string{"CLERK_PUBLISHABLE_KEY", "VITE_CLERK_PUBLISHABLE_KEY"},
			deployClerkPublishableKeyRef,
			true,
		)
		if err != nil {
			return deployProject{}, options, err
		}
		options.ClerkSecretKey, options.ClerkSecretKeySource, err = resolveDeploySecretValue(
			"Clerk secret key",
			[]string{"CLERK_SECRET_KEY"},
			deployClerkSecretKeyRef,
			true,
		)
		if err != nil {
			return deployProject{}, options, err
		}
		options.ConnectorRegistrationToken, options.ConnectorRegistrationTokenSource, err = resolveDeploySecretValue(
			"connector registration token",
			[]string{"PROJECT_CONNECTOR_REGISTRATION_TOKEN"},
			deployConnectorRegistrationTokenRef,
			true,
		)
		if err != nil {
			return deployProject{}, options, err
		}
	}

	webURL := ""
	apiURL := ""
	if options.ProjectDomain != "" {
		webURL = "https://" + options.ProjectDomain
	}
	if options.APIDomain != "" {
		apiURL = "https://" + options.APIDomain
	}
	return deployProject{
		Name:       projectName,
		RemoteURL:  remoteURL,
		RemoteRef:  repoRef,
		RemotePath: options.RemotePath,
		Branch:     options.Branch,
		WebURL:     webURL,
		APIURL:     apiURL,
	}, options, nil
}

func readDeployConfig(projectRoot string) (deployConfig, error) {
	path := filepath.Join(projectRoot, "deploy", "deploy.yaml")
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return deployConfig{}, nil
	}
	if err != nil {
		return deployConfig{}, fmt.Errorf("read deploy/deploy.yaml: %w", err)
	}
	config := deployConfig{}
	if err := yaml.Unmarshal(body, &config); err != nil {
		return deployConfig{}, fmt.Errorf("parse deploy/deploy.yaml: %w", err)
	}
	return config, nil
}

func resolveDeployValue(cmd *cobra.Command, input *bufio.Reader, label string, flagName string, flagValue string, candidates []deployCandidate, required bool) (string, error) {
	if cmd.Flags().Changed(flagName) {
		if required && flagValue == "" {
			return "", fmt.Errorf("%s is required; pass --%s", label, flagName)
		}
		return flagValue, nil
	}
	for _, candidate := range candidates {
		value := strings.TrimSpace(candidate.Value)
		if value == "" {
			continue
		}
		accepted, err := confirmDeployCandidate(cmd, input, label, flagName, value, candidate.Source)
		if err != nil {
			return "", err
		}
		if accepted {
			return value, nil
		}
		return "", fmt.Errorf("%s from %s was declined; rerun with --%s or update deploy/deploy.yaml", label, candidate.Source, flagName)
	}
	if required {
		return "", fmt.Errorf("%s is required; pass --%s, set an environment variable, or add it to deploy/deploy.yaml", label, flagName)
	}
	return "", nil
}

func confirmDeployCandidate(cmd *cobra.Command, input *bufio.Reader, label string, flagName string, value string, source string) (bool, error) {
	fmt.Fprintf(cmd.OutOrStdout(), "Use %s from %s: %s? Y/n ", label, source, value)
	answer, err := input.ReadString('\n')
	if err != nil && answer == "" {
		return false, fmt.Errorf("confirm %s: rerun with --%s or provide input", label, flagName)
	}
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "", "y", "yes":
		return true, nil
	case "n", "no":
		return false, nil
	default:
		return false, fmt.Errorf("confirm %s: answer y or n", label)
	}
}

func configCandidate(value string, source string) deployCandidate {
	return deployCandidate{Value: value, Source: source}
}

func firstEnvCandidate(names ...string) deployCandidate {
	for _, name := range names {
		if value := os.Getenv(name); value != "" {
			return deployCandidate{Value: value, Source: "$" + name}
		}
	}
	return deployCandidate{}
}

func resolveDeploySecretValue(label string, envNames []string, onePasswordRef string, required bool) (string, string, error) {
	for _, name := range envNames {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value, "$" + name, nil
		}
	}

	if onePasswordRef != "" {
		output, err := runCommand("", nil, "op", "read", onePasswordRef)
		if err == nil {
			value := strings.TrimRight(output, "\r\n")
			if value != "" {
				return value, onePasswordRef, nil
			}
		}
		if required {
			if err != nil {
				return "", "", fmt.Errorf("read %s from 1Password: %w", label, err)
			}
			return "", "", fmt.Errorf("%s from 1Password was empty", label)
		}
	}

	return "", "", nil
}

func deploySteps(project deployProject, options deployOptions) []string {
	remotePath := shellQuote(project.RemotePath)
	return []string{
		"set -e; docker --version; docker compose version; docker info >/dev/null",
		"set -e; docker network inspect traefik-public >/dev/null",
		fmt.Sprintf("set -e; sudo -n mkdir -p %s; sudo -n chown $(id -u):$(id -g) %s", remotePath, remotePath),
		fmt.Sprintf("set -e; if [ -d %s/.git ]; then cd %s && git fetch origin %s && git reset --hard origin/%s; else git clone --branch %s %s %s; fi", remotePath, remotePath, shellQuote(project.Branch), shellQuote(project.Branch), shellQuote(project.Branch), shellQuote(project.RemoteURL), remotePath),
		composeUpStep(project, options),
		composeStatusStep(project, options),
	}
}

func composeUpStep(project deployProject, options deployOptions) string {
	return fmt.Sprintf(
		"set -e; cd %s; cat > .env <<'PROJECT_SPACE_ENV'\n%s\nPROJECT_SPACE_ENV\ndocker compose --env-file .env -f deploy/compose.yml -f deploy/ingress.labels.yml up -d --build",
		shellQuote(project.RemotePath),
		deployEnvFileContent(options, false),
	)
}

func composeStatusStep(project deployProject, options deployOptions) string {
	return fmt.Sprintf("set -e; cd %s; docker compose --env-file .env -f deploy/compose.yml -f deploy/ingress.labels.yml ps", shellQuote(project.RemotePath))
}

func deployStatusEnv(options deployOptions) string {
	parts := []string{
		"PROJECT_DOMAIN=" + shellQuote(options.ProjectDomain),
		"PROJECT_API_DOMAIN=" + shellQuote(options.APIDomain),
	}
	if options.AcmeEmail != "" {
		parts = append(parts, "TRAEFIK_ACME_EMAIL="+shellQuote(options.AcmeEmail))
	}
	return strings.Join(parts, " ")
}

func deployEnvFileContent(options deployOptions, includeSecretValues bool) string {
	secretValue := func(value string, source string) string {
		if includeSecretValues {
			return value
		}
		return secretSourceLabel(source)
	}

	lines := []string{
		"PROJECT_DOMAIN=" + options.ProjectDomain,
		"PROJECT_API_DOMAIN=" + options.APIDomain,
	}
	if options.AcmeEmail != "" {
		lines = append(lines, "TRAEFIK_ACME_EMAIL="+options.AcmeEmail)
	}
	if options.GitHubToken != "" {
		lines = append(lines, "GITHUB_TOKEN="+secretValue(options.GitHubToken, options.GitHubTokenSource))
	}
	if options.GitHubOAuthClientID != "" {
		lines = append(lines, "GITHUB_OAUTH_CLIENT_ID="+secretValue(options.GitHubOAuthClientID, options.GitHubOAuthClientIDSource))
	}
	if options.ClerkPublishableKey != "" {
		lines = append(lines, "CLERK_PUBLISHABLE_KEY="+secretValue(options.ClerkPublishableKey, options.ClerkPublishableKeySource))
		lines = append(lines, "VITE_CLERK_PUBLISHABLE_KEY="+secretValue(options.ClerkPublishableKey, options.ClerkPublishableKeySource))
	}
	if options.ClerkSecretKey != "" {
		lines = append(lines, "CLERK_SECRET_KEY="+secretValue(options.ClerkSecretKey, options.ClerkSecretKeySource))
	}
	if options.ConnectorRegistrationToken != "" {
		lines = append(lines, "PROJECT_CONNECTOR_REGISTRATION_TOKEN="+secretValue(options.ConnectorRegistrationToken, options.ConnectorRegistrationTokenSource))
	}
	return strings.Join(lines, "\n")
}

func secretSourceLabel(source string) string {
	if source == "" {
		return "<secret>"
	}
	return "<secret from " + source + ">"
}

func deployComposeScript(project deployProject, options deployOptions, up bool) string {
	command := "docker compose --env-file .env -f deploy/compose.yml -f deploy/ingress.labels.yml ps"
	if up {
		command = "docker compose --env-file .env -f deploy/compose.yml -f deploy/ingress.labels.yml up -d --build"
	}
	return strings.Join([]string{
		"set -e",
		"cd " + shellQuote(project.RemotePath),
		"cat > .env <<'PROJECT_SPACE_ENV'",
		deployEnvFileContent(options, true),
		"PROJECT_SPACE_ENV",
		command,
	}, "\n")
}

func runRemoteScript(host string, script string) (string, error) {
	return runCommand("", []byte(script), "ssh", host, "sh", "-s")
}

func defaultAPIDomain(domain string) string {
	const suffix = ".os-home.net"
	if strings.HasSuffix(domain, suffix) {
		return strings.TrimSuffix(domain, suffix) + "-api" + suffix
	}
	if domain == "" {
		return ""
	}
	return "api-" + domain
}

func gitRemoteURL(projectRoot string) (string, error) {
	output, err := runCommand(projectRoot, nil, "git", "remote", "get-url", "origin")
	if err != nil {
		return "", fmt.Errorf("read git origin remote: %w", err)
	}
	remoteURL := strings.TrimSpace(output)
	return normalizeGitHubRemoteURL(remoteURL), nil
}

func normalizeGitHubRemoteURL(remoteURL string) string {
	if strings.HasPrefix(remoteURL, "git@github.com:") {
		path := strings.TrimSuffix(strings.TrimPrefix(remoteURL, "git@github.com:"), ".git")
		return "https://github.com/" + path
	}
	return remoteURL
}

func gitCurrentBranch(projectRoot string) (string, error) {
	output, err := runCommand(projectRoot, nil, "git", "branch", "--show-current")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(output), nil
}

func gitConfigValue(projectRoot string, name string) (string, error) {
	output, err := runCommand(projectRoot, nil, "git", "config", "--get", name)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(output), nil
}

func printDeployResult(cmd *cobra.Command, project deployProject, dryRun bool) {
	if dryRun {
		fmt.Fprintln(cmd.OutOrStdout(), "Deploy dry run")
	} else {
		fmt.Fprintln(cmd.OutOrStdout(), "Deploy complete")
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Project: %s\n", project.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "Remote path: %s\n", project.RemotePath)
	fmt.Fprintf(cmd.OutOrStdout(), "Branch: %s\n", project.Branch)
	if project.WebURL != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Web: %s\n", project.WebURL)
	}
	if project.APIURL != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "API: %s\n", project.APIURL)
	}
	if dryRun {
		fmt.Fprintln(cmd.OutOrStdout(), "\nRemote steps")
		for _, step := range project.Steps {
			fmt.Fprintf(cmd.OutOrStdout(), "- %s\n", step)
		}
	}
}

func printDeployStatus(cmd *cobra.Command, project deployProject) {
	fmt.Fprintln(cmd.OutOrStdout(), "Deploy status")
	fmt.Fprintf(cmd.OutOrStdout(), "Project: %s\n", project.Name)
	fmt.Fprintf(cmd.OutOrStdout(), "Remote path: %s\n", project.RemotePath)
	fmt.Fprintf(cmd.OutOrStdout(), "Branch: %s\n", project.Branch)
	if project.WebURL != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Web: %s\n", project.WebURL)
	}
	if project.APIURL != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "API: %s\n", project.APIURL)
	}
	if project.Status != "" {
		fmt.Fprintln(cmd.OutOrStdout(), "\nRemote")
		fmt.Fprintln(cmd.OutOrStdout(), project.Status)
	}
}
