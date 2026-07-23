package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/spf13/cobra"
)

type previewStatusReport struct {
	CheckedAt string              `json:"checkedAt,omitempty"`
	Previews  []previewStatusItem `json:"previews"`
}

type previewStatusItem struct {
	RepositoryFullName string `json:"repositoryFullName"`
	PullRequestNumber  int    `json:"pullRequestNumber"`
	PullRequestURL     string `json:"pullRequestUrl,omitempty"`
	HeadBranch         string `json:"headBranch,omitempty"`
	RequestedSHA       string `json:"requestedSha,omitempty"`
	RunningSHA         string `json:"runningSha,omitempty"`
	LiveURL            string `json:"liveUrl,omitempty"`
	State              string `json:"state"`
	VerifiedAt         string `json:"verifiedAt,omitempty"`
	UpdatedAt          string `json:"updatedAt,omitempty"`
	Message            string `json:"message,omitempty"`
}

func readPreviewStatus(projectRoot string, pullRequest int, deps previewDependencies) (previewStatusReport, error) {
	repository, err := resolvePreviewRepository(projectRoot, deps.run)
	if err != nil {
		return previewStatusReport{}, err
	}
	config, err := readDeployConfig(projectRoot)
	if err != nil {
		return previewStatusReport{}, err
	}
	statusHost := strings.TrimSpace(config.Preview.StatusHost)
	if statusHost == "" {
		return previewStatusReport{}, fmt.Errorf("deploy/deploy.yaml preview.statusHost is required for preview status")
	}
	output, err := deps.run(projectRoot, nil, "ssh", statusHost, "status-all")
	if err != nil {
		return previewStatusReport{}, fmt.Errorf("read preview status from VPS: %w", err)
	}
	items, err := decodePreviewStatus(strings.NewReader(output), repository)
	if err != nil {
		return previewStatusReport{}, err
	}
	if pullRequest > 0 {
		filtered := make([]previewStatusItem, 0, 1)
		for _, item := range items {
			if item.PullRequestNumber == pullRequest {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}
	return previewStatusReport{
		CheckedAt: deps.now().UTC().Format(time.RFC3339),
		Previews:  items,
	}, nil
}

func decodePreviewStatus(reader io.Reader, expectedRepository string) ([]previewStatusItem, error) {
	decoder := json.NewDecoder(reader)
	byPullRequest := map[int]previewStatusItem{}
	for {
		var raw json.RawMessage
		if err := decoder.Decode(&raw); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return nil, fmt.Errorf("decode preview status registry: %w", err)
		}
		records, err := previewStatusRecords(raw)
		if err != nil {
			return nil, err
		}
		for _, item := range records {
			if !strings.EqualFold(item.RepositoryFullName, expectedRepository) {
				continue
			}
			if err := validatePreviewStatusItem(item); err != nil {
				return nil, fmt.Errorf("reject unsafe preview status for PR #%d: %w", item.PullRequestNumber, err)
			}
			current, exists := byPullRequest[item.PullRequestNumber]
			if !exists || statusItemIsNewer(item, current) {
				byPullRequest[item.PullRequestNumber] = item
			}
		}
	}
	items := make([]previewStatusItem, 0, len(byPullRequest))
	for _, item := range byPullRequest {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].PullRequestNumber < items[j].PullRequestNumber })
	return items, nil
}

func previewStatusRecords(raw json.RawMessage) ([]previewStatusItem, error) {
	var envelope struct {
		Records json.RawMessage `json:"records"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("decode preview status registry: %w", err)
	}
	if len(envelope.Records) > 0 {
		var records []previewStatusItem
		if err := json.Unmarshal(envelope.Records, &records); err != nil {
			return nil, fmt.Errorf("decode preview status registry records: %w", err)
		}
		return records, nil
	}
	var item previewStatusItem
	if err := json.Unmarshal(raw, &item); err != nil {
		return nil, fmt.Errorf("decode preview status registry item: %w", err)
	}
	return []previewStatusItem{item}, nil
}

func validatePreviewStatusItem(item previewStatusItem) error {
	if !githubRepositoryNamePattern.MatchString(item.RepositoryFullName) {
		return fmt.Errorf("invalid repository name")
	}
	if item.PullRequestNumber <= 0 {
		return fmt.Errorf("invalid pull request number")
	}
	identityMayBeAbsent := item.State == "removed" || item.State == "absent"
	if (item.RequestedSHA == "" && !identityMayBeAbsent) || (item.RequestedSHA != "" && !fullGitSHA.MatchString(item.RequestedSHA)) {
		return fmt.Errorf("requestedSha must be a full lowercase Git SHA for runtime states")
	}
	if item.RunningSHA != "" && !fullGitSHA.MatchString(item.RunningSHA) {
		return fmt.Errorf("runningSha must be a full lowercase Git SHA")
	}
	if !safePreviewText(item.HeadBranch, 256) || !safePreviewText(item.Message, 512) {
		return fmt.Errorf("text fields contain unsupported control characters or exceed their limits")
	}
	if item.State == "" || len(item.State) > 64 || !safePreviewState(item.State) {
		return fmt.Errorf("invalid state")
	}
	if item.PullRequestURL != "" {
		expected := fmt.Sprintf("https://github.com/%s/pull/%d", item.RepositoryFullName, item.PullRequestNumber)
		if item.PullRequestURL != expected {
			return fmt.Errorf("pullRequestUrl does not match the preview identity")
		}
	}
	if item.LiveURL != "" {
		if err := validatePreviewLiveURL(item.LiveURL, item.PullRequestNumber); err != nil {
			return err
		}
	}
	for name, value := range map[string]string{"verifiedAt": item.VerifiedAt, "updatedAt": item.UpdatedAt} {
		if value != "" {
			if _, err := time.Parse(time.RFC3339, value); err != nil {
				return fmt.Errorf("%s must be RFC3339", name)
			}
		}
	}
	return nil
}

func validatePreviewLiveURL(value string, pullRequest int) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return fmt.Errorf("liveUrl must be an exact HTTPS preview origin")
	}
	expectedHost := fmt.Sprintf("pr-%d.projects.os-home.net", pullRequest)
	if parsed.Host != expectedHost {
		return fmt.Errorf("liveUrl does not match the preview identity")
	}
	return nil
}

func safePreviewText(value string, limit int) bool {
	if len(value) > limit {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func safePreviewState(value string) bool {
	for index, character := range value {
		if character >= 'a' && character <= 'z' || index > 0 && character >= '0' && character <= '9' || index > 0 && (character == '_' || character == '-') {
			continue
		}
		return false
	}
	return true
}

func statusItemIsNewer(candidate previewStatusItem, current previewStatusItem) bool {
	candidateTime, candidateErr := time.Parse(time.RFC3339, candidate.UpdatedAt)
	currentTime, currentErr := time.Parse(time.RFC3339, current.UpdatedAt)
	if candidateErr == nil && currentErr == nil {
		return candidateTime.After(currentTime) || candidateTime.Equal(currentTime)
	}
	return candidateErr == nil || currentErr != nil
}

func printPreviewStatus(cmd *cobra.Command, report previewStatusReport, format string) error {
	if err := validatePreviewFormat(format); err != nil {
		return err
	}
	if format == "json" {
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		return encoder.Encode(report)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Preview status checked at %s\n", report.CheckedAt)
	if len(report.Previews) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No preview status was reported.")
		return nil
	}
	for _, item := range report.Previews {
		fmt.Fprintf(cmd.OutOrStdout(), "\nPR #%d: %s\n", item.PullRequestNumber, item.State)
		fmt.Fprintf(cmd.OutOrStdout(), "Repository: %s\n", item.RepositoryFullName)
		if item.RequestedSHA != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "Requested: %s\n", item.RequestedSHA)
		}
		if item.RunningSHA != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "Running: %s\n", item.RunningSHA)
		}
		if item.LiveURL != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "Verified URL: %s\n", item.LiveURL)
		}
		if item.Message != "" {
			fmt.Fprintf(cmd.OutOrStdout(), "Message: %s\n", item.Message)
		}
	}
	return nil
}
