package projectchat

import (
	"context"
	"os"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var codexThreadIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const (
	threadIDEnvironmentVariable  = "CODEX_THREAD_ID"
	agentNameEnvironmentVariable = "CODEX_AGENT_NAME"
	taskTitleEnvironmentVariable = "CODEX_TASK_TITLE"
	maxAgentNameCharacters       = 48
	maxTaskTitleCharacters       = 160
)

type EnvironmentThreadIdentityProvider struct {
	LookupEnv func(string) (string, bool)
}

func (provider EnvironmentThreadIdentityProvider) ThreadID(context.Context) (string, error) {
	lookup := provider.LookupEnv
	if lookup == nil {
		lookup = os.LookupEnv
	}
	threadID, found := lookup(threadIDEnvironmentVariable)
	if !found || strings.TrimSpace(threadID) == "" {
		return "", ErrMissingThreadID
	}
	if err := validateThreadID(threadID); err != nil {
		return "", err
	}
	return threadID, nil
}

func validateThreadID(threadID string) error {
	if !codexThreadIDPattern.MatchString(threadID) {
		return ErrInvalidThreadID
	}
	return nil
}

type EnvironmentAgentProfileProvider struct {
	LookupEnv func(string) (string, bool)
}

func (provider EnvironmentAgentProfileProvider) AgentProfile(context.Context) (AgentProfile, error) {
	lookup := provider.LookupEnv
	if lookup == nil {
		lookup = os.LookupEnv
	}
	displayName, found := lookup(agentNameEnvironmentVariable)
	if !found || strings.TrimSpace(displayName) == "" {
		return AgentProfile{}, ErrMissingAgentName
	}
	taskTitle, _ := lookup(taskTitleEnvironmentVariable)
	profile := AgentProfile{
		DisplayName: strings.TrimSpace(displayName),
		TaskTitle:   strings.TrimSpace(taskTitle),
	}
	if !validProfileText(profile.DisplayName, maxAgentNameCharacters, false) ||
		!validProfileText(profile.TaskTitle, maxTaskTitleCharacters, true) {
		return AgentProfile{}, ErrInvalidAgentName
	}
	return profile, nil
}

func validProfileText(value string, maxCharacters int, allowEmpty bool) bool {
	if !utf8.ValidString(value) || (!allowEmpty && value == "") {
		return false
	}
	if utf16Length(value) > maxCharacters {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) || unicode.Is(unicode.Bidi_Control, character) {
			return false
		}
	}
	return true
}
