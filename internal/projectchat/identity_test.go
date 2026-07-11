package projectchat

import (
	"context"
	"errors"
	"testing"
)

func TestEnvironmentThreadIdentityProvider(t *testing.T) {
	tests := []struct {
		name      string
		value     string
		found     bool
		want      string
		wantError error
	}{
		{name: "missing", wantError: ErrMissingThreadID},
		{name: "blank", value: "  ", found: true, wantError: ErrMissingThreadID},
		{name: "header injection", value: "thread-1\r\nInjected: yes", found: true, wantError: ErrInvalidThreadID},
		{name: "secret shaped", value: "glpat-012345678901234567890123456789", found: true, wantError: ErrInvalidThreadID},
		{name: "generic identifier", value: "thread-mira", found: true, wantError: ErrInvalidThreadID},
		{name: "valid", value: "019f49e1-cc3d-7243-bc12-75c74c786457", found: true, want: "019f49e1-cc3d-7243-bc12-75c74c786457"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			provider := EnvironmentThreadIdentityProvider{
				LookupEnv: func(name string) (string, bool) {
					if name != "CODEX_THREAD_ID" {
						t.Fatalf("unexpected environment variable %q", name)
					}
					return test.value, test.found
				},
			}
			got, err := provider.ThreadID(context.Background())
			if !errors.Is(err, test.wantError) {
				t.Fatalf("ThreadID() error = %v, want %v", err, test.wantError)
			}
			if got != test.want {
				t.Fatalf("ThreadID() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestEnvironmentAgentProfileProvider(t *testing.T) {
	tests := []struct {
		name      string
		values    map[string]string
		want      AgentProfile
		wantError error
	}{
		{name: "missing", values: map[string]string{}, wantError: ErrMissingAgentName},
		{name: "blank", values: map[string]string{"CODEX_AGENT_NAME": "  "}, wantError: ErrMissingAgentName},
		{
			name:      "bidi control",
			values:    map[string]string{"CODEX_AGENT_NAME": "Mira\u202e"},
			wantError: ErrInvalidAgentName,
		},
		{
			name: "valid",
			values: map[string]string{
				"CODEX_AGENT_NAME": "  Mira  ",
				"CODEX_TASK_TITLE": "  Project Chat  ",
			},
			want: AgentProfile{DisplayName: "Mira", TaskTitle: "Project Chat"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			provider := EnvironmentAgentProfileProvider{
				LookupEnv: func(name string) (string, bool) {
					value, found := test.values[name]
					return value, found
				},
			}
			got, err := provider.AgentProfile(context.Background())
			if !errors.Is(err, test.wantError) {
				t.Fatalf("AgentProfile() error = %v, want %v", err, test.wantError)
			}
			if got != test.want {
				t.Fatalf("AgentProfile() = %#v, want %#v", got, test.want)
			}
		})
	}
}
