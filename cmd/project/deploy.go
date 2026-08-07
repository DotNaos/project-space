package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

type deployOptions struct {
	Environment    string
	AllEnvs        bool
	Format         string
	Host           string
	RemotePath     string
	Branch         string
	ProjectDomain  string
	APIDomain      string
	AcmeEmail      string
	Secrets        map[string]deploySecretValue
	DryRun         bool
	Commit         string
	ReleaseVersion string
	LockTimeout    time.Duration
}

type deployProject struct {
	Name           string          `json:"name"`
	BuildCommit    string          `json:"buildCommit,omitempty"`
	BuildRef       string          `json:"buildRef,omitempty"`
	BuildTime      string          `json:"buildTime,omitempty"`
	BuildVersion   string          `json:"buildVersion,omitempty"`
	Environment    string          `json:"environment"`
	RemoteURL      string          `json:"remoteUrl"`
	RemoteRef      string          `json:"remoteRef"`
	RemotePath     string          `json:"remotePath"`
	Branch         string          `json:"branch"`
	ComposeProject string          `json:"composeProject"`
	WebURL         string          `json:"webUrl"`
	APIURL         string          `json:"apiUrl"`
	DocsURL        string          `json:"docsUrl"`
	Steps          []string        `json:"steps,omitempty"`
	Status         string          `json:"status,omitempty"`
	RemoteStatus   string          `json:"remoteStatus,omitempty"`
	Phases         []deployPhase   `json:"phases,omitempty"`
	Evidence       *deployEvidence `json:"evidence,omitempty"`
	Rollback       *deployRollback `json:"rollback,omitempty"`
	Error          string          `json:"error,omitempty"`
}

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
			result, deployErr := deployProjectToVPS(cmd, resolved, options)
			if result.Name != "" {
				if err := printDeployResult(cmd, result, options); err != nil {
					return err
				}
			}
			return deployErr
		},
	}
	addDeployFlags(cmd, &options)
	cmd.AddCommand(newDeployStatusCommand())
	cmd.AddCommand(newDeployPreviewCommand())
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
			result, err := deployProjectStatusReport(cmd, resolved, options)
			if err != nil {
				return err
			}
			return printDeployStatusReport(cmd, result, options.Format)
		},
	}
	addDeployFlags(cmd, &options)
	cmd.Flags().BoolVar(&options.AllEnvs, "all-envs", false, "inspect all configured environments")
	must(cmd.Flags().MarkHidden("dry-run"))
	return cmd
}

func addDeployFlags(cmd *cobra.Command, options *deployOptions) {
	cmd.Flags().StringVar(&options.Environment, "env", "", "deployment environment: prod or beta")
	cmd.Flags().StringVar(&options.Format, "format", "pretty", "output format")
	cmd.Flags().StringVar(&options.Host, "host", "", "SSH host")
	cmd.Flags().StringVar(&options.RemotePath, "path", "", "remote project directory")
	cmd.Flags().StringVar(&options.Branch, "branch", "", "git branch to deploy")
	cmd.Flags().StringVar(&options.ProjectDomain, "domain", "", "project domain")
	cmd.Flags().StringVar(&options.APIDomain, "api-domain", "", "project API domain")
	cmd.Flags().StringVar(&options.AcmeEmail, "email", "", "Traefik ACME email")
	cmd.Flags().BoolVar(&options.DryRun, "dry-run", false, "print planned remote actions without changing the VPS")
	cmd.Flags().StringVar(&options.Commit, "commit", "", "full Git commit SHA to deploy")
	cmd.Flags().StringVar(&options.ReleaseVersion, "release-version", "", "signed release version approved for this commit")
	cmd.Flags().DurationVar(&options.LockTimeout, "lock-timeout", 15*time.Minute, "maximum time to wait for the remote deployment lock")
	must(cmd.RegisterFlagCompletionFunc("env", fixedValuesCompletion("prod", "beta")))
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "json")))
	must(cmd.RegisterFlagCompletionFunc("path", directoryCompletion))
}

func deployProjectStatus(cmd *cobra.Command, projectRoot string, options deployOptions) (deployProject, error) {
	project, options, err := resolveDeployProject(cmd, projectRoot, options, false)
	if err != nil {
		return deployProject{}, err
	}
	clearLocalBuildMetadata(&project)
	status, err := readDeployRemoteStatus(project, options)
	if err != nil {
		return deployProject{}, err
	}
	project.RemoteStatus = status
	parseDeployEvents(&project, status)
	if project.Evidence != nil {
		project.BuildCommit = project.Evidence.RunningBuildCommit
	}
	if project.Status == "" {
		project.Status = "unhealthy"
	}
	return project, nil
}

func readDeployRemoteStatus(project deployProject, options deployOptions) (string, error) {
	if options.ProjectDomain == "" {
		options.ProjectDomain = "status.local"
	}
	if options.APIDomain == "" {
		options.APIDomain = "status-api.local"
	}
	statusScript := deployStatusEvidenceScript(project)
	output, err := runCommand("", nil, "ssh", options.Host, statusScript)
	if err != nil {
		return "", fmt.Errorf("read deployment status: %w", err)
	}
	return strings.TrimSpace(output), nil
}

func deployProjectStatusReport(cmd *cobra.Command, projectRoot string, options deployOptions) (deployStatusReport, error) {
	config, err := readDeployConfig(projectRoot)
	if err != nil {
		return deployStatusReport{}, err
	}
	envNames := []string{options.Environment}
	if options.AllEnvs {
		envNames = deployEnvironmentNames(config)
	} else if options.Environment == "" {
		return deployStatusReport{}, fmt.Errorf("deployment environment is required; use --env prod, --env beta, or --all-envs")
	}
	report := deployStatusReport{
		ProjectRoot: projectRoot,
		Host:        config.Host,
	}
	for _, envName := range envNames {
		envOptions := options
		envOptions.Environment = envName
		envOptions.AllEnvs = false
		project, envOptions, err := resolveDeployProject(cmd, projectRoot, envOptions, false)
		if err != nil {
			return deployStatusReport{}, err
		}
		clearLocalBuildMetadata(&project)
		status, err := readDeployRemoteStatus(project, envOptions)
		if err != nil {
			project.Status = "status unavailable: " + err.Error()
		} else {
			project.RemoteStatus = status
			parseDeployEvents(&project, status)
			if project.Evidence != nil {
				project.BuildCommit = project.Evidence.RunningBuildCommit
			}
			if project.Status == "" {
				project.Status = "unhealthy"
			}
		}
		report.ProjectName = project.Name
		report.Environments = append(report.Environments, project)
	}
	return report, nil
}

func clearLocalBuildMetadata(project *deployProject) {
	project.BuildCommit = ""
	project.BuildRef = ""
	project.BuildTime = ""
	project.BuildVersion = ""
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
	if options.Environment == "" {
		return deployProject{}, options, fmt.Errorf("deployment environment is required; use --env prod or --env beta")
	}
	envConfig, ok := config.Environments[options.Environment]
	if !ok {
		return deployProject{}, options, fmt.Errorf("unknown deployment environment %q; use prod or beta", options.Environment)
	}

	remoteURL, err := gitRemoteURL(projectRoot)
	if err != nil {
		return deployProject{}, options, err
	}
	repoRef, err := githubRepositoryRef(remoteURL)
	if err != nil {
		return deployProject{}, options, err
	}
	projectName := strings.TrimPrefix(repoRef[strings.LastIndex(repoRef, "/"):], "/")

	options.Host, err = resolveDeployValue(cmd, "deploy host", "host", options.Host, []deployCandidate{
		configCandidate(config.Host, "deploy/deploy.yaml"),
	}, true)
	if err != nil {
		return deployProject{}, options, err
	}
	options.RemotePath, err = resolveDeployValue(cmd, "remote path", "path", options.RemotePath, []deployCandidate{
		configCandidate(envConfig.Path, "deploy/deploy.yaml"),
	}, true)
	if err != nil {
		return deployProject{}, options, err
	}
	options.Branch, err = resolveDeployValue(cmd, "git branch", "branch", options.Branch, []deployCandidate{
		configCandidate(envConfig.Branch, "deploy/deploy.yaml"),
	}, true)
	if err != nil {
		return deployProject{}, options, err
	}
	options.ProjectDomain, err = resolveDeployValue(cmd, "project domain", "domain", options.ProjectDomain, []deployCandidate{
		configCandidate(envConfig.Domain, "deploy/deploy.yaml"),
	}, requireRuntimeValues)
	if err != nil {
		return deployProject{}, options, err
	}
	options.APIDomain, err = resolveDeployValue(cmd, "project API domain", "api-domain", options.APIDomain, []deployCandidate{
		configCandidate(envConfig.APIDomain, "deploy/deploy.yaml"),
	}, requireRuntimeValues)
	if err != nil {
		return deployProject{}, options, err
	}
	options.AcmeEmail, _ = resolveDeployValue(cmd, "ACME email", "email", options.AcmeEmail, []deployCandidate{
		configCandidate(envConfig.Email, "deploy/deploy.yaml"),
	}, false)
	secretSources := mergedDeploySecrets(config.Secrets, envConfig.Secrets)
	if requireRuntimeValues {
		options.Secrets, err = resolveDeploySecrets(secretSources)
		if err != nil {
			return deployProject{}, options, err
		}
	} else {
		options.Secrets = deploySecretSources(secretSources)
	}

	webURL := ""
	apiURL := ""
	docsURL := ""
	if options.ProjectDomain != "" {
		webURL = "https://" + options.ProjectDomain
		docsURL = webURL + "/docs"
	}
	if options.APIDomain != "" {
		apiURL = "https://" + options.APIDomain
	}
	buildCommit, _ := gitCommit(projectRoot)
	buildRef, _ := gitCurrentBranch(projectRoot)
	if buildRef == "" {
		buildRef = options.Branch
	}
	buildVersion, _ := packageVersion(projectRoot)

	return deployProject{
		Name:           projectName,
		BuildCommit:    buildCommit,
		BuildRef:       buildRef,
		BuildTime:      time.Now().UTC().Format(time.RFC3339),
		BuildVersion:   buildVersion,
		Environment:    options.Environment,
		RemoteURL:      remoteURL,
		RemoteRef:      repoRef,
		RemotePath:     options.RemotePath,
		Branch:         options.Branch,
		ComposeProject: composeProjectName(projectName, options.Environment),
		WebURL:         webURL,
		APIURL:         apiURL,
		DocsURL:        docsURL,
	}, options, nil
}

func gitRemoteURL(projectRoot string) (string, error) {
	output, err := runCommand(projectRoot, nil, "git", "remote", "get-url", "origin")
	if err != nil {
		return "", fmt.Errorf("read git origin remote: %w", err)
	}
	remoteURL := strings.TrimSpace(output)
	return normalizeGitHubRemoteURL(remoteURL), nil
}

func packageVersion(projectRoot string) (string, error) {
	body, err := os.ReadFile(filepath.Join(projectRoot, "package.json"))
	if err != nil {
		return "", err
	}
	return packageVersionFromJSON(body)
}

func packageVersionFromJSON(body []byte) (string, error) {
	var packageJSON struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(body, &packageJSON); err != nil {
		return "", err
	}
	return strings.TrimSpace(packageJSON.Version), nil
}

func gitCommit(projectRoot string) (string, error) {
	output, err := runCommand(projectRoot, nil, "git", "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(output), nil
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
