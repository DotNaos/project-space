package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestCLIDocsModelMatchesVisibleCommandTree(t *testing.T) {
	model := buildCLIDocsModel(newRootCommand())
	paths := make(map[string]int)
	visitCLIDocsCommands(model.Root, func(command cliDocsCommand) {
		paths[command.Path]++
	})
	for _, path := range []string{
		"project self-update",
		"project dev-build create",
		"project deploy preview",
		"project deploy preview status",
		"project deploy preview destroy",
		"project completion",
		"project completion bash",
		"project completion fish",
		"project completion powershell",
		"project completion zsh",
		"project help",
	} {
		if paths[path] != 1 {
			t.Errorf("generated path %q count = %d, want 1", path, paths[path])
		}
	}
	for _, path := range []string{
		"project __docs-model",
		"project __runtime-supervisor",
		"project connector service",
	} {
		if paths[path] != 0 {
			t.Errorf("hidden path %q leaked into generated docs", path)
		}
	}
}

func TestCLIDocsModelIsDeterministicAndEnvironmentIndependent(t *testing.T) {
	t.Setenv("PROJECT_APPROVAL_TRUST_ROOT", "first-sensitive-local-value")
	first := encodedCLIDocsModel(t, buildCLIDocsModel(newRootCommand()))
	t.Setenv("PROJECT_APPROVAL_TRUST_ROOT", "second-sensitive-local-value")
	second := encodedCLIDocsModel(t, buildCLIDocsModel(newRootCommand()))
	if !bytes.Equal(first, second) {
		t.Fatal("generated CLI docs changed with the local environment")
	}
	if bytes.Contains(first, []byte("sensitive-local-value")) {
		t.Fatal("generated CLI docs exposed an environment-derived flag default")
	}
}

func TestCLIDocsModelCapturesFlagsAliasesAndInheritedScope(t *testing.T) {
	root := &cobra.Command{Use: "fixture", Short: "Fixture root"}
	root.PersistentFlags().StringP("format", "f", "pretty", "output format")
	child := &cobra.Command{Use: "show <name>", Short: "Show one item", Aliases: []string{"display"}, Run: func(*cobra.Command, []string) {}}
	child.Flags().BoolP("json", "j", false, "print JSON")
	root.AddCommand(child)

	model := buildCLIDocsModel(root)
	var generated cliDocsCommand
	for _, command := range model.Root.Commands {
		if command.Name == "show" {
			generated = command
			break
		}
	}
	if generated.Path != "fixture show" || generated.Usage != "show <name>" || generated.Short != "Show one item" {
		t.Fatalf("unexpected generated command: %#v", generated)
	}
	if len(generated.Aliases) != 1 || generated.Aliases[0] != "display" {
		t.Fatalf("aliases = %q", generated.Aliases)
	}
	flags := make(map[string]cliDocsFlag)
	for _, flag := range generated.Flags {
		flags[flag.Name] = flag
	}
	if flag := flags["json"]; flag.Type != "bool" || flag.Shorthand != "j" || flag.Inherited {
		t.Fatalf("local flag = %#v", flag)
	}
	if flag := flags["format"]; flag.Type != "string" || flag.Shorthand != "f" || !flag.Inherited {
		t.Fatalf("inherited flag = %#v", flag)
	}
}

func TestCLIDocsMDXRendersSourceBoundaryAndSelfUpdate(t *testing.T) {
	var output bytes.Buffer
	if err := renderCLIDocsMDX(&output, buildCLIDocsModel(newRootCommand())); err != nil {
		t.Fatalf("render MDX: %v", err)
	}
	for _, value := range []string{
		"current `main` source",
		"managed macOS, Linux, and WSL",
		"<h3 id=\"project-self-update\"",
		"`--check`",
		"[`self-update`](#project-self-update)",
		"[Self-update](/docs/cli/self-update)",
	} {
		if !strings.Contains(output.String(), value) {
			t.Errorf("generated MDX does not contain %q", value)
		}
	}
}

func encodedCLIDocsModel(t *testing.T, model cliDocsModel) []byte {
	t.Helper()
	var output bytes.Buffer
	if err := encodeCLIDocsModel(&output, model); err != nil {
		t.Fatalf("encode CLI docs: %v", err)
	}
	return output.Bytes()
}

func visitCLIDocsCommands(command cliDocsCommand, visit func(cliDocsCommand)) {
	visit(command)
	for _, child := range command.Commands {
		visitCLIDocsCommands(child, visit)
	}
}
