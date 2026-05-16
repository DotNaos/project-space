package projectspace

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

func loadEnv() {
	root := repoRoot()
	readEnv(filepath.Join(root, ".env.local"), false)
	readEnv(filepath.Join(root, ".env.op"), true)
}

func readEnv(path string, override bool) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		if _, exists := os.LookupEnv(key); exists && !override {
			continue
		}
		os.Setenv(strings.TrimSpace(key), strings.Trim(strings.TrimSpace(value), "\"'"))
	}
}

func getenv(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func repoRoot() string {
	current, _ := os.Getwd()
	candidates := []string{
		current,
		filepath.Dir(current),
		filepath.Dir(filepath.Dir(current)),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(filepath.Join(candidate, "apps", "web")); err == nil {
			return candidate
		}
	}
	return current
}
