package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const deployEventPrefix = "PROJECT_DEPLOY_EVENT|"

var fullCommitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
var stableReleaseVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type deployPhase struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

type deployEvidence struct {
	RequestedCommit        string `json:"requestedCommit"`
	MainHeadCommit         string `json:"mainHeadCommit,omitempty"`
	PreviousVerifiedCommit string `json:"previousVerifiedCommit,omitempty"`
	RemoteCheckoutCommit   string `json:"remoteCheckoutCommit,omitempty"`
	RunningBuildCommit     string `json:"runningBuildCommit,omitempty"`
	ContainerImageID       string `json:"containerImageId,omitempty"`
	LockOwner              string `json:"lockOwner,omitempty"`
	LockAcquiredAt         string `json:"lockAcquiredAt,omitempty"`
	ComposeHealthy         bool   `json:"composeHealthy"`
	HTTPHealthy            bool   `json:"httpHealthy"`
	LiveOriginHealthy      bool   `json:"liveOriginHealthy"`
}

type deployRollback struct {
	Status         string `json:"status"`
	Commit         string `json:"commit,omitempty"`
	VerifiedCommit string `json:"verifiedCommit,omitempty"`
	Error          string `json:"error,omitempty"`
}

type deployStateError struct {
	State string
	Err   error
}

func (e deployStateError) Error() string {
	if e.Err == nil {
		return e.State
	}
	return e.Err.Error()
}

func (e deployStateError) Unwrap() error { return e.Err }

var resolveDeployRemoteHead = gitRemoteBranchHead
var executeDeployRemoteTransaction = runDeployRemoteTransaction

func deployProjectToVPS(cmd *cobra.Command, projectRoot string, options deployOptions) (deployProject, error) {
	project, plannedOptions, err := resolveDeployProject(cmd, projectRoot, options, false)
	if err != nil {
		return deployProject{}, err
	}
	project.Status = "checking"
	project.Phases = append(project.Phases, deployPhase{Name: "checking", Status: "running"})

	if project.Environment == deployProdEnvironment && project.Branch != "main" {
		return failDeployProject(project, "failed_before_deploy", fmt.Errorf("production deploys must target the main branch"))
	}

	requested, current, err := resolveExactDeployCommit(projectRoot, project.Branch, options.Commit)
	project.Evidence = &deployEvidence{RequestedCommit: requested, MainHeadCommit: current}
	if err != nil {
		state := "failed_before_deploy"
		if _, ok := err.(deployStateError); ok {
			state = err.(deployStateError).State
		}
		return failDeployProject(project, state, err)
	}

	project.BuildCommit = requested
	project.BuildRef = "refs/heads/" + project.Branch
	project.BuildTime = time.Now().UTC().Format(time.RFC3339)
	if err := ensureDeployCommitAvailable(projectRoot, project.Branch, requested); err != nil {
		return failDeployProject(project, "failed_before_deploy", err)
	}
	version, err := resolveDeployReleaseVersion(
		projectRoot,
		project.Environment,
		requested,
		options.ReleaseVersion,
	)
	if err != nil {
		return failDeployProject(project, "failed_before_deploy", err)
	}
	project.BuildVersion = version
	project.Phases[len(project.Phases)-1].Status = "success"
	project.Phases = append(project.Phases, deployPhase{Name: "validating", Status: "success", Detail: "exact commit accepted"})

	plannedOptions.Commit = requested
	project.Steps = deployTransactionPlan(project, plannedOptions)
	if options.DryRun {
		project.Status = "validated"
		return project, nil
	}

	runtimeProject, runtimeOptions, err := resolveDeployProject(cmd, projectRoot, options, true)
	if err != nil {
		return failDeployProject(project, "failed_before_deploy", err)
	}
	runtimeProject.BuildCommit = project.BuildCommit
	runtimeProject.BuildRef = project.BuildRef
	runtimeProject.BuildTime = project.BuildTime
	runtimeProject.BuildVersion = project.BuildVersion
	runtimeProject.Phases = project.Phases
	runtimeProject.Evidence = project.Evidence
	runtimeProject.Steps = project.Steps
	runtimeOptions.Commit = requested

	output, remoteErr := executeDeployRemoteTransaction(runtimeOptions.Host, deployTransactionScript(runtimeProject, runtimeOptions))
	if remoteErr != nil {
		output = remoteErr.Error()
	}
	parseDeployEvents(&runtimeProject, output)
	if remoteErr != nil {
		if runtimeProject.Status == "" || runtimeProject.Status == "checking" {
			runtimeProject.Status = "failed"
		}
		runtimeProject.Error = lastNonEventLine(output)
		if runtimeProject.Error == "" {
			runtimeProject.Error = remoteErr.Error()
		}
		return runtimeProject, fmt.Errorf("production deployment %s: %w", runtimeProject.Status, remoteErr)
	}
	if runtimeProject.Status != "success" {
		return failDeployProject(runtimeProject, "failed", fmt.Errorf("remote deployment ended without success evidence"))
	}
	return runtimeProject, nil
}

func resolveDeployReleaseVersion(
	projectRoot string,
	environment string,
	commit string,
	configured string,
) (string, error) {
	version := strings.TrimSpace(configured)
	if version == "" {
		if environment == deployProdEnvironment {
			return "", fmt.Errorf("production deploys require --release-version from the published signed release")
		}
		var err error
		version, err = packageVersionAtCommit(projectRoot, commit)
		if err != nil {
			return "", err
		}
	}
	if !stableReleaseVersionPattern.MatchString(version) {
		return "", fmt.Errorf("release version must be stable Semantic Versioning")
	}
	return version, nil
}

func ensureDeployCommitAvailable(projectRoot string, branch string, commit string) error {
	if _, err := runCommand(projectRoot, nil, "git", "cat-file", "-e", commit+"^{commit}"); err == nil {
		return nil
	}
	if _, err := runCommand(projectRoot, nil, "git", "fetch", "--no-tags", "origin", "refs/heads/"+branch); err != nil {
		return fmt.Errorf("fetch accepted commit %s: %w", commit, err)
	}
	if _, err := runCommand(projectRoot, nil, "git", "cat-file", "-e", commit+"^{commit}"); err != nil {
		return fmt.Errorf("accepted commit %s is unavailable after fetch: %w", commit, err)
	}
	return nil
}

func resolveExactDeployCommit(projectRoot string, branch string, requested string) (string, string, error) {
	current, err := resolveDeployRemoteHead(projectRoot, branch)
	if err != nil {
		return strings.TrimSpace(requested), "", fmt.Errorf("resolve current origin/%s: %w", branch, err)
	}
	requested = strings.TrimSpace(requested)
	if requested == "" {
		requested = current
	}
	if !fullCommitPattern.MatchString(requested) {
		return requested, current, fmt.Errorf("commit must be a full 40-character lowercase Git SHA")
	}
	if requested != current {
		return requested, current, deployStateError{State: "superseded", Err: fmt.Errorf("commit %s is superseded by current origin/%s %s", requested, branch, current)}
	}
	return requested, current, nil
}

func gitRemoteBranchHead(projectRoot string, branch string) (string, error) {
	output, err := runCommand(projectRoot, nil, "git", "ls-remote", "--exit-code", "origin", "refs/heads/"+branch)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(output)
	if len(fields) < 2 || fields[1] != "refs/heads/"+branch || !fullCommitPattern.MatchString(fields[0]) {
		return "", fmt.Errorf("origin returned an invalid %s head", branch)
	}
	return fields[0], nil
}

func packageVersionAtCommit(projectRoot string, commit string) (string, error) {
	output, err := runCommand(projectRoot, nil, "git", "show", commit+":package.json")
	if err != nil {
		return "", fmt.Errorf("read package.json at %s: %w", commit, err)
	}
	return packageVersionFromJSON([]byte(output))
}

func failDeployProject(project deployProject, state string, err error) (deployProject, error) {
	project.Status = state
	project.Error = err.Error()
	project.Phases = append(project.Phases, deployPhase{Name: state, Status: "failed", Detail: err.Error()})
	return project, deployStateError{State: state, Err: err}
}

func parseDeployEvents(project *deployProject, output string) {
	for _, line := range strings.Split(output, "\n") {
		if !strings.HasPrefix(line, deployEventPrefix) {
			continue
		}
		parts := strings.SplitN(strings.TrimPrefix(line, deployEventPrefix), "|", 4)
		if len(parts) < 3 {
			continue
		}
		kind, key, value := parts[0], parts[1], parts[2]
		detail := ""
		if len(parts) == 4 {
			detail = parts[3]
		}
		switch kind {
		case "phase":
			project.Phases = append(project.Phases, deployPhase{Name: key, Status: value, Detail: detail})
			if value == "running" || value == "failed" || value == "success" {
				project.Status = key
			}
		case "state":
			project.Status = key
			if value != "" {
				project.Error = value
			}
		case "evidence":
			applyDeployEvidence(project, key, value)
		case "rollback":
			if project.Rollback == nil {
				project.Rollback = &deployRollback{}
			}
			switch key {
			case "status":
				project.Rollback.Status = value
			case "commit":
				project.Rollback.Commit = value
			case "verifiedCommit":
				project.Rollback.VerifiedCommit = value
			case "error":
				project.Rollback.Error = value
			}
		}
	}
}

func applyDeployEvidence(project *deployProject, key string, value string) {
	if project.Evidence == nil {
		project.Evidence = &deployEvidence{}
	}
	switch key {
	case "reset":
		requested := project.Evidence.RequestedCommit
		mainHead := project.Evidence.MainHeadCommit
		previous := project.Evidence.PreviousVerifiedCommit
		lockOwner := project.Evidence.LockOwner
		lockAcquiredAt := project.Evidence.LockAcquiredAt
		project.Evidence = &deployEvidence{
			RequestedCommit: requested, MainHeadCommit: mainHead,
			PreviousVerifiedCommit: previous, LockOwner: lockOwner, LockAcquiredAt: lockAcquiredAt,
		}
	case "mainHeadCommit":
		project.Evidence.MainHeadCommit = value
	case "previousVerifiedCommit":
		project.Evidence.PreviousVerifiedCommit = value
	case "remoteCheckoutCommit":
		project.Evidence.RemoteCheckoutCommit = value
	case "runningBuildCommit":
		project.Evidence.RunningBuildCommit = value
	case "containerImageId":
		project.Evidence.ContainerImageID = value
	case "lockOwner":
		project.Evidence.LockOwner = value
	case "lockAcquiredAt":
		project.Evidence.LockAcquiredAt = value
	case "composeHealthy":
		project.Evidence.ComposeHealthy, _ = strconv.ParseBool(value)
	case "httpHealthy":
		project.Evidence.HTTPHealthy, _ = strconv.ParseBool(value)
	case "liveOriginHealthy":
		project.Evidence.LiveOriginHealthy, _ = strconv.ParseBool(value)
	}
}

func lastNonEventLine(output string) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimSpace(lines[index])
		if line != "" && !strings.HasPrefix(line, deployEventPrefix) {
			return line
		}
	}
	return ""
}

func runDeployRemoteTransaction(host string, script string) (string, error) {
	return runRemoteScript(host, script)
}
