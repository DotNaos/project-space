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
	Host          string
	RemotePath    string
	Branch        string
	ProjectDomain string
	AcmeEmail     string
	DryRun        bool
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
	Host   string `yaml:"host"`
	Path   string `yaml:"path"`
	Branch string `yaml:"branch"`
	Domain string `yaml:"domain"`
	Email  string `yaml:"email"`
}

type deployCandidate struct {
	Value  string
	Source string
}

func newDeployCommand() *cobra.Command {
	options := deployOptions{}
	cmd := &cobra.Command{
		Use:               "deploy [project-directory]",
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
		Use:               "status [project-directory]",
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
	domain := options.ProjectDomain
	if domain == "" {
		domain = "status.local"
	}
	email := options.AcmeEmail
	if email == "" {
		email = "status@example.com"
	}
	env := fmt.Sprintf("PROJECT_DOMAIN=%s TRAEFIK_ACME_EMAIL=%s", shellQuote(domain), shellQuote(email))
	statusScript := strings.Join([]string{
		"set -e",
		"echo SSH ok",
		"docker --version",
		"docker compose version",
		"if docker info >/dev/null 2>&1; then echo docker api ok; else echo docker api unavailable; fi",
		"if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx ingress; then echo ingress running; else echo ingress missing; fi",
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
	if _, err := os.Stat(filepath.Join(projectRoot, "deploy", "ingress.compose.yml")); err != nil {
		return deployProject{}, options, fmt.Errorf("deploy/ingress.compose.yml is required: %w", err)
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
	gitEmail, _ := gitConfigValue(projectRoot, "user.email")

	options.Host, err = resolveDeployValue(cmd, input, "deploy host", "host", options.Host, []deployCandidate{
		configCandidate(config.Host, "deploy/deploy.yaml"),
		firstEnvCandidate("PROJECT_DEPLOY_HOST", "DEPLOY_HOST"),
		{Value: "os-vps", Source: "standard SSH host"},
	}, true)
	if err != nil {
		return deployProject{}, options, err
	}
	options.RemotePath, err = resolveDeployValue(cmd, input, "remote path", "path", options.RemotePath, []deployCandidate{
		configCandidate(config.Path, "deploy/deploy.yaml"),
		firstEnvCandidate("PROJECT_DEPLOY_PATH", "DEPLOY_PATH"),
		{Value: "/opt/projects/" + projectName, Source: "project name"},
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
	options.AcmeEmail, err = resolveDeployValue(cmd, input, "ACME email", "email", options.AcmeEmail, []deployCandidate{
		configCandidate(config.Email, "deploy/deploy.yaml"),
		firstEnvCandidate("TRAEFIK_ACME_EMAIL", "PROJECT_DEPLOY_ACME_EMAIL"),
		configCandidate(gitEmail, "Git config user.email"),
	}, requireRuntimeValues)
	if err != nil {
		return deployProject{}, options, err
	}

	webURL := ""
	apiURL := ""
	if options.ProjectDomain != "" {
		webURL = "https://" + options.ProjectDomain
		apiURL = "https://api." + options.ProjectDomain
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

func deploySteps(project deployProject, options deployOptions) []string {
	env := fmt.Sprintf("PROJECT_DOMAIN=%s TRAEFIK_ACME_EMAIL=%s", shellQuote(options.ProjectDomain), shellQuote(options.AcmeEmail))
	return []string{
		"set -e; docker --version; docker compose version; docker info >/dev/null",
		fmt.Sprintf("set -e; mkdir -p %s", shellQuote(project.RemotePath)),
		fmt.Sprintf("set -e; if [ -d %s/.git ]; then cd %s && git fetch origin %s && git reset --hard origin/%s; else git clone --branch %s %s %s; fi", shellQuote(project.RemotePath), shellQuote(project.RemotePath), shellQuote(project.Branch), shellQuote(project.Branch), shellQuote(project.Branch), shellQuote(project.RemoteURL), shellQuote(project.RemotePath)),
		fmt.Sprintf("set -e; if docker ps --format '{{.Names}}' | grep -qx ingress; then echo ingress already running; else cd %s; %s docker compose -f deploy/ingress.compose.yml up -d; fi", shellQuote(project.RemotePath), env),
		fmt.Sprintf("set -e; cd %s; %s docker compose -f deploy/compose.yml -f deploy/ingress.labels.yml up -d --build", shellQuote(project.RemotePath), env),
		fmt.Sprintf("set -e; cd %s; docker compose -f deploy/compose.yml -f deploy/ingress.labels.yml ps", shellQuote(project.RemotePath)),
	}
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
