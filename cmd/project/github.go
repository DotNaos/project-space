package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const projectServiceAccountTokenRef = "op://projects/yiw7onwcvruugyi2ji6c4crwpy/password"

type createGitHubRepositoryOptions struct {
	Visibility string
}

type createGitHubRepositoryResult struct {
	URL             string
	SecretSet       bool
	RulesetsApplied int
}

type githubRulesetDocument map[string]json.RawMessage

type githubRulesetBypassActor struct {
	ActorID    int64  `json:"actor_id"`
	ActorType  string `json:"actor_type"`
	BypassMode string `json:"bypass_mode"`
}

type githubRulesetSummary struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

func createGitHubRepository(projectRoot string, options createGitHubRepositoryOptions) (createGitHubRepositoryResult, error) {
	repoName, err := githubRepositoryName(projectRoot)
	if err != nil {
		return createGitHubRepositoryResult{}, err
	}
	if _, err := exec.LookPath("gh"); err != nil {
		return createGitHubRepositoryResult{}, errors.New("gh is required for --github")
	}
	if _, err := exec.LookPath("git"); err != nil {
		return createGitHubRepositoryResult{}, errors.New("git is required for --github")
	}
	if _, err := exec.LookPath("op"); err != nil {
		return createGitHubRepositoryResult{}, errors.New("op is required for --github")
	}

	output, err := runCommand("", nil, "gh", "repo", "create", repoName, githubRepositoryVisibilityFlag(options.Visibility))
	if err != nil {
		return createGitHubRepositoryResult{}, fmt.Errorf("create GitHub repository: %w", err)
	}
	repoURL := firstNonEmptyLine(output)
	if repoURL == "" {
		repoURL, err = repositoryURL(repoName)
		if err != nil {
			return createGitHubRepositoryResult{}, err
		}
	}
	repoRef, err := githubRepositoryRef(repoURL)
	if err != nil {
		return createGitHubRepositoryResult{}, err
	}

	token, err := readProjectServiceAccountToken()
	if err != nil {
		return createGitHubRepositoryResult{}, err
	}
	if err := setGitHubSecret(repoRef, token); err != nil {
		return createGitHubRepositoryResult{}, err
	}

	if err := initializeAndPushRepository(projectRoot, repoURL); err != nil {
		return createGitHubRepositoryResult{}, err
	}
	rulesetsApplied, err := applyGitHubRulesets(projectRoot, repoRef)
	if err != nil {
		return createGitHubRepositoryResult{}, err
	}
	return createGitHubRepositoryResult{
		URL:             repoURL,
		SecretSet:       true,
		RulesetsApplied: rulesetsApplied,
	}, nil
}

func applyGitHubRulesets(projectRoot string, repoRef string) (int, error) {
	paths, err := filepath.Glob(filepath.Join(projectRoot, ".github", "rulesets", "*.json"))
	if err != nil {
		return 0, fmt.Errorf("find GitHub rulesets: %w", err)
	}
	sort.Strings(paths)
	if len(paths) == 0 {
		return 0, nil
	}

	actorOutput, err := runCommand("", nil, "gh", "api", "user", "--jq", ".id")
	if err != nil {
		return 0, fmt.Errorf("read authenticated GitHub user: %w", err)
	}
	actorID, err := strconv.ParseInt(strings.TrimSpace(actorOutput), 10, 64)
	if err != nil || actorID <= 0 {
		return 0, errors.New("authenticated GitHub user ID was invalid")
	}

	listOutput, err := runCommand("", nil, "gh", "api", "repos/"+repoRef+"/rulesets?includes_parents=false")
	if err != nil {
		return 0, fmt.Errorf("list GitHub rulesets: %w", err)
	}
	var existing []githubRulesetSummary
	if err := json.Unmarshal([]byte(listOutput), &existing); err != nil {
		return 0, fmt.Errorf("decode GitHub rulesets: %w", err)
	}
	idsByName := make(map[string]int64, len(existing))
	for _, ruleset := range existing {
		idsByName[ruleset.Name] = ruleset.ID
	}

	seen := make(map[string]string, len(paths))
	for _, path := range paths {
		document, name, err := readGitHubRuleset(path)
		if err != nil {
			return 0, err
		}
		if previous, ok := seen[name]; ok {
			return 0, fmt.Errorf(
				"GitHub rulesets %s and %s have the same name %q",
				previous,
				path,
				name,
			)
		}
		seen[name] = path

		if err := addGitHubRulesetCreatorBypass(document, actorID); err != nil {
			return 0, fmt.Errorf("prepare GitHub ruleset %s: %w", path, err)
		}
		payload, err := json.Marshal(document)
		if err != nil {
			return 0, fmt.Errorf("encode GitHub ruleset %s: %w", path, err)
		}

		method := "POST"
		endpoint := "repos/" + repoRef + "/rulesets"
		if id, ok := idsByName[name]; ok {
			method = "PUT"
			endpoint += "/" + strconv.FormatInt(id, 10)
		}
		if _, err := runCommand("", payload, "gh", "api", "--method", method, endpoint, "--input", "-"); err != nil {
			return 0, fmt.Errorf("apply GitHub ruleset %q: %w", name, err)
		}
	}

	return len(paths), nil
}

func readGitHubRuleset(path string) (githubRulesetDocument, string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, "", fmt.Errorf("read GitHub ruleset %s: %w", path, err)
	}
	var document githubRulesetDocument
	if err := json.Unmarshal(content, &document); err != nil {
		return nil, "", fmt.Errorf("decode GitHub ruleset %s: %w", path, err)
	}
	if document == nil {
		return nil, "", fmt.Errorf("GitHub ruleset %s must be a JSON object", path)
	}
	var name string
	if err := json.Unmarshal(document["name"], &name); err != nil {
		return nil, "", fmt.Errorf("GitHub ruleset %s has an invalid name", path)
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, "", fmt.Errorf("GitHub ruleset %s has no name", path)
	}
	return document, name, nil
}

func addGitHubRulesetCreatorBypass(document githubRulesetDocument, actorID int64) error {
	var actors []githubRulesetBypassActor
	if raw, ok := document["bypass_actors"]; ok {
		if err := json.Unmarshal(raw, &actors); err != nil {
			return errors.New("bypass_actors must be an array")
		}
	}
	for _, actor := range actors {
		if actor.ActorType == "User" && actor.ActorID == actorID {
			return nil
		}
	}
	actors = append(actors, githubRulesetBypassActor{
		ActorID:    actorID,
		ActorType:  "User",
		BypassMode: "pull_request",
	})
	encoded, err := json.Marshal(actors)
	if err != nil {
		return fmt.Errorf("encode bypass actors: %w", err)
	}
	document["bypass_actors"] = encoded
	return nil
}

func githubRepositoryVisibilityFlag(visibility string) string {
	if visibility == "public" {
		return "--public"
	}
	return "--private"
}

func githubRepositoryName(projectRoot string) (string, error) {
	name := filepath.Base(filepath.Clean(projectRoot))
	if name == "" || name == "." || name == string(filepath.Separator) {
		return "", fmt.Errorf("cannot derive GitHub repository name from %q", projectRoot)
	}
	return name, nil
}

func repositoryURL(repoName string) (string, error) {
	output, err := runCommand("", nil, "gh", "repo", "view", repoName, "--json", "url", "--jq", ".url")
	if err != nil {
		return "", fmt.Errorf("read GitHub repository URL: %w", err)
	}
	repoURL := firstNonEmptyLine(output)
	if repoURL == "" {
		return "", errors.New("GitHub repository URL was empty")
	}
	return repoURL, nil
}

func readProjectServiceAccountToken() (string, error) {
	var lastErr error
	for _, ref := range []string{projectTokenRef, legacyProjectTokenRef} {
		output, err := runCommand("", nil, "op", "read", ref)
		if err != nil {
			lastErr = err
			continue
		}
		token := strings.TrimRight(output, "\r\n")
		if token != "" {
			return token, nil
		}
		lastErr = errors.New("OP_SERVICE_ACCOUNT_TOKEN from 1Password was empty")
	}
	return "", fmt.Errorf("read OP_SERVICE_ACCOUNT_TOKEN from 1Password: %w", lastErr)
}

func setGitHubSecret(repoRef string, token string) error {
	if _, err := runCommand("", []byte(token), "gh", "secret", "set", "OP_SERVICE_ACCOUNT_TOKEN", "--repo", repoRef); err != nil {
		return fmt.Errorf("set GitHub secret OP_SERVICE_ACCOUNT_TOKEN: %w", err)
	}
	return nil
}

func initializeAndPushRepository(projectRoot string, repoURL string) error {
	commands := [][]string{
		{"git", "init"},
		{"git", "branch", "-M", "main"},
		{"git", "add", "-A"},
		{"git", "commit", "-m", "Initial project"},
		{"git", "remote", "add", "origin", repoURL},
		{"git", "push", "-u", "origin", "main"},
	}
	for _, command := range commands {
		if _, err := runCommand(projectRoot, nil, command[0], command[1:]...); err != nil {
			return fmt.Errorf("%s: %w", strings.Join(command, " "), err)
		}
	}
	return nil
}

func githubRepositoryRef(repoURL string) (string, error) {
	parsed, err := url.Parse(repoURL)
	if err != nil {
		return "", fmt.Errorf("parse GitHub repository URL: %w", err)
	}
	if parsed.Host != "github.com" {
		return "", fmt.Errorf("unsupported GitHub repository URL %q", repoURL)
	}
	path := strings.Trim(strings.TrimSuffix(parsed.Path, ".git"), "/")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", fmt.Errorf("unsupported GitHub repository URL %q", repoURL)
	}
	return parts[0] + "/" + parts[1], nil
}

func firstNonEmptyLine(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			return line
		}
	}
	return ""
}

var runExternalCommand = executeCommand

func runCommand(dir string, stdin []byte, name string, args ...string) (string, error) {
	return runExternalCommand(dir, stdin, name, args...)
}

func executeCommand(dir string, stdin []byte, name string, args ...string) (string, error) {
	command := exec.Command(name, args...)
	command.Dir = dir
	if stdin != nil {
		command.Stdin = bytes.NewReader(stdin)
	}
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return "", errors.New(message)
	}
	return string(output), nil
}
