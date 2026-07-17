package codextask

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadPromptSupportsLiteralStdinAndFile(t *testing.T) {
	t.Run("literal", func(t *testing.T) {
		prompt, err := LoadPrompt(PromptSource{Message: "First line\nSecond line"})
		if err != nil || prompt != "First line\nSecond line" {
			t.Fatalf("prompt = %q, error = %v", prompt, err)
		}
	})

	t.Run("stdin", func(t *testing.T) {
		prompt, err := LoadPrompt(PromptSource{Message: "-", Input: strings.NewReader("from stdin\n")})
		if err != nil || prompt != "from stdin\n" {
			t.Fatalf("prompt = %q, error = %v", prompt, err)
		}
	})

	t.Run("file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "prompt.txt")
		if err := os.WriteFile(path, []byte("from file\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		prompt, err := LoadPrompt(PromptSource{PromptFile: path})
		if err != nil || prompt != "from file\n" {
			t.Fatalf("prompt = %q, error = %v", prompt, err)
		}
	})
}

func TestLoadPromptRejectsAmbiguousEmptyInvalidAndOversizedInput(t *testing.T) {
	tests := []struct {
		name   string
		source PromptSource
	}{
		{name: "ambiguous", source: PromptSource{Message: "message", PromptFile: "prompt.txt"}},
		{name: "missing", source: PromptSource{}},
		{name: "missing stdin", source: PromptSource{Message: "-"}},
		{name: "empty", source: PromptSource{Message: "   \n"}},
		{name: "nul", source: PromptSource{Message: "bad\x00prompt"}},
		{name: "oversized", source: PromptSource{Message: strings.Repeat("x", 9), MaximumBytes: 8}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := LoadPrompt(test.source); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoadPromptCapsReadersWithoutConsumingUnboundedInput(t *testing.T) {
	_, err := LoadPrompt(PromptSource{
		Message: "-", Input: strings.NewReader(strings.Repeat("x", 33)), MaximumBytes: 32,
	})
	if err == nil || errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("error = %v", err)
	}
}
