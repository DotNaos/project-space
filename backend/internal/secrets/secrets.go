package secrets

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"
)

func Command(defaultItem string) *cobra.Command {
	command := &cobra.Command{Use: "secrets", Short: "Manage local 1Password-backed secrets"}
	command.AddCommand(&cobra.Command{
		Use:   "init",
		Short: "Create or verify the per-project 1Password item",
		RunE: func(cmd *cobra.Command, args []string) error {
			return initItem(defaultItem)
		},
	})
	command.AddCommand(&cobra.Command{
		Use:   "pull",
		Short: "Write .env.op from 1Password secret fields",
		RunE: func(cmd *cobra.Command, args []string) error {
			return pull(defaultItem)
		},
	})
	command.AddCommand(&cobra.Command{
		Use:   "doctor",
		Short: "Check local and GitHub secret presence without printing values",
		RunE: func(cmd *cobra.Command, args []string) error {
			return doctor()
		},
	})
	push := &cobra.Command{
		Use:   "push-github --repo OWNER/REPO",
		Short: "Copy .env.op secrets into GitHub Actions secrets",
		RunE: func(cmd *cobra.Command, args []string) error {
			repo, _ := cmd.Flags().GetString("repo")
			return pushGitHub(repo)
		},
	}
	push.Flags().String("repo", "", "GitHub repository, for example DotNaos/project-space")
	command.AddCommand(push)
	return command
}

func initItem(defaultItem string) error {
	env := loadConfig()
	item := fallback(env["DOTNAOS_OP_ITEM"], defaultItem)
	vault := fallback(env["DOTNAOS_OP_VAULT"], "Private")
	if _, err := exec.LookPath("op"); err != nil {
		return err
	}
	if exec.Command("op", "item", "get", item, "--vault", vault).Run() == nil {
		fmt.Println("1Password item already exists")
		return nil
	}
	create := exec.Command("op", "item", "create", "--category", "secure-note", "--vault", vault, "--title", item)
	create.Stdin = os.Stdin
	create.Stdout = os.Stdout
	create.Stderr = os.Stderr
	return create.Run()
}

func pull(defaultItem string) error {
	env := loadConfig()
	item := fallback(env["DOTNAOS_OP_ITEM"], defaultItem)
	vault := fallback(env["DOTNAOS_OP_VAULT"], "Private")
	var output bytes.Buffer
	for _, key := range secretKeys() {
		value, err := opField(vault, item, key)
		if err != nil {
			fmt.Fprintf(os.Stderr, "missing %s in 1Password item\n", key)
			continue
		}
		output.WriteString(key + "=" + shellQuote(value) + "\n")
	}
	if output.Len() == 0 {
		return fmt.Errorf("no secrets were pulled")
	}
	if err := os.WriteFile(".env.op", output.Bytes(), 0o600); err != nil {
		return err
	}
	fmt.Println("wrote .env.op")
	return nil
}

func doctor() error {
	for _, tool := range []string{"op", "gh"} {
		if path, err := exec.LookPath(tool); err == nil {
			fmt.Printf("ok %s: %s\n", tool, path)
		} else {
			fmt.Printf("missing %s\n", tool)
		}
	}
	for _, key := range secretKeys() {
		if os.Getenv(key) != "" {
			fmt.Printf("ok env %s\n", key)
		} else {
			fmt.Printf("check %s\n", key)
		}
	}
	return nil
}

func pushGitHub(repo string) error {
	if repo == "" {
		return fmt.Errorf("missing --repo")
	}
	values := readEnvFile(".env.op")
	for _, key := range githubSecretKeys() {
		value := values[key]
		if value == "" {
			fmt.Fprintf(os.Stderr, "skip missing %s\n", key)
			continue
		}
		cmd := exec.Command("gh", "secret", "set", key, "--repo", repo, "--body", value)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return err
		}
	}
	return nil
}

func secretKeys() []string {
	return classifiedKeys("secret:")
}

func githubSecretKeys() []string {
	values := readEnvFile(".env.github.example")
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	return keys
}

func classifiedKeys(marker string) []string {
	file, err := os.Open(".env.example")
	if err != nil {
		return nil
	}
	defer file.Close()
	keys := []string{}
	next := false
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "# "+marker) {
			next = true
			continue
		}
		if strings.HasPrefix(line, "#") || line == "" {
			continue
		}
		key, _, ok := strings.Cut(line, "=")
		if ok && next {
			keys = append(keys, key)
		}
		next = false
	}
	return keys
}

func loadConfig() map[string]string {
	values := readEnvFile(".env.local")
	for key, value := range readEnvFile(".env.op") {
		values[key] = value
	}
	for _, env := range os.Environ() {
		key, value, ok := strings.Cut(env, "=")
		if ok {
			values[key] = value
		}
	}
	return values
}

func readEnvFile(path string) map[string]string {
	values := map[string]string{}
	file, err := os.Open(path)
	if err != nil {
		return values
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[key] = strings.Trim(value, "\"'")
		}
	}
	return values
}

func opField(vault string, item string, field string) (string, error) {
	cmd := exec.Command("op", "item", "get", item, "--vault", vault, "--fields", "label="+field)
	body, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(body)), nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func fallback(value string, other string) string {
	if value == "" {
		return other
	}
	return value
}
