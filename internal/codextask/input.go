package codextask

import (
	"errors"
	"io"
	"os"
	"strings"
	"unicode/utf8"
)

const DefaultMaximumPromptBytes int64 = 16_000

type PromptSource struct {
	Input        io.Reader
	MaximumBytes int64
	Message      string
	PromptFile   string
}

func LoadPrompt(source PromptSource) (string, error) {
	maximum := source.MaximumBytes
	if maximum == 0 {
		maximum = DefaultMaximumPromptBytes
	}
	if maximum < 1 || maximum > 1<<20 || source.PromptFile != "" && source.Message != "" {
		return "", ErrInvalidInput
	}
	if source.PromptFile != "" {
		return loadPromptFile(source.PromptFile, maximum)
	}
	if source.Message == "-" {
		if source.Input == nil {
			return "", errors.New("--message - requires standard input")
		}
		return loadPromptReader(source.Input, maximum)
	}
	if source.Message == "" {
		return "", errors.New("provide --message or --prompt-file")
	}
	return validatePrompt([]byte(source.Message), maximum)
}

func loadPromptFile(path string, maximum int64) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", errors.New("read prompt file")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("prompt file must be a regular file")
	}
	return loadPromptReader(file, maximum)
}

func loadPromptReader(reader io.Reader, maximum int64) (string, error) {
	value, err := io.ReadAll(io.LimitReader(reader, maximum+1))
	if err != nil {
		return "", errors.New("read prompt input")
	}
	return validatePrompt(value, maximum)
}

func validatePrompt(value []byte, maximum int64) (string, error) {
	if int64(len(value)) > maximum {
		return "", errors.New("prompt input is too large")
	}
	if !utf8.Valid(value) || strings.ContainsRune(string(value), '\x00') || strings.TrimSpace(string(value)) == "" {
		return "", ErrInvalidInput
	}
	return string(value), nil
}
