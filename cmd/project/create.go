package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/DotNaos/project-space/internal/projectvalidator"
	"github.com/spf13/cobra"
)

func newCreateCommand() *cobra.Command {
	options := projectvalidator.InitOptions{}
	localTmp := false
	globalTmp := false
	github := false
	githubVisibility := "private"
	targets := []string{}
	cmd := &cobra.Command{
		Use:               "create [directory]",
		Aliases:           []string{"new"},
		Short:             "Create and initialize a new project",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			selections, err := parseAppTargetSelections(targets)
			if err != nil {
				return err
			}
			options.Targets = selections
			if cmd.Flags().Changed("github-visibility") && !github {
				return fmt.Errorf("--github-visibility requires --github")
			}
			if !isGitHubVisibility(githubVisibility) {
				return fmt.Errorf("--github-visibility must be private or public")
			}
			if localTmp && globalTmp {
				return fmt.Errorf("--local-tmp and --global-tmp cannot be used together")
			}
			useTmp := localTmp || globalTmp
			if !useTmp && len(args) == 0 {
				return fmt.Errorf("project directory is required unless --tmp, --local-tmp, or --global-tmp is used")
			}
			target := ""
			if len(args) == 1 {
				target = args[0]
			}
			if useTmp {
				var err error
				target, err = tmpProjectTarget(target, globalTmp)
				if err != nil {
					return err
				}
				if err := os.RemoveAll(target); err != nil {
					return err
				}
			}
			resolved, err := filepath.Abs(target)
			if err != nil {
				return err
			}
			lockPath, err := projectvalidator.CreateProject(resolved, options)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Created project: %s\n", resolved)
			fmt.Fprintf(cmd.OutOrStdout(), "Initialized project template lock: %s\n", lockPath)
			if useTmp {
				valuesPath, err := projectvalidator.WriteTmpTemplateValues(resolved)
				if err != nil {
					return err
				}
				fmt.Fprintf(cmd.OutOrStdout(), "Wrote tmp template values: %s\n", valuesPath)
				plans, err := projectvalidator.InstallDefaultModules(resolved)
				if err != nil {
					return err
				}
				for _, plan := range plans {
					fmt.Fprintf(cmd.OutOrStdout(), "Installed module: %s\n", plan.Module)
				}
			}
			if github {
				result, err := createGitHubRepository(resolved, createGitHubRepositoryOptions{
					Visibility: githubVisibility,
				})
				if err != nil {
					return err
				}
				fmt.Fprintf(cmd.OutOrStdout(), "GitHub repository: %s\n", result.URL)
				fmt.Fprintln(cmd.OutOrStdout(), "Pushed initial commit: main")
			}
			fmt.Fprintf(cmd.OutOrStdout(), "cd %s\n", shellQuote(resolved))
			return nil
		},
	}
	addInitFlags(cmd, &options)
	cmd.Flags().BoolVar(&github, "github", false, "create a private GitHub repository and push the project")
	cmd.Flags().StringVar(&githubVisibility, "github-visibility", "private", "GitHub repository visibility")
	cmd.Flags().BoolVar(&localTmp, "tmp", false, "create a local tmp project in ./tmp and install default modules")
	cmd.Flags().BoolVar(&localTmp, "local-tmp", false, "create a local tmp project in ./tmp and install default modules")
	cmd.Flags().BoolVar(&globalTmp, "global-tmp", false, "create a global tmp project in /tmp and install default modules")
	cmd.Flags().StringArrayVar(&targets, "target", nil, "app target and devices (<target>:<device>[,<device>...]); repeat for multiple targets")
	must(cmd.RegisterFlagCompletionFunc("github-visibility", fixedValuesCompletion("private", "public")))
	return cmd
}

func isGitHubVisibility(value string) bool {
	return value == "private" || value == "public"
}

func tmpProjectTarget(name string, global bool) (string, error) {
	suffix, err := randomSuffix()
	if err != nil {
		return "", err
	}
	if name == "" {
		name = "generated-app"
	}
	base := filepath.Base(filepath.Clean(name))
	if base == "." || base == string(filepath.Separator) {
		base = "generated-app"
	}
	base = base + "-" + suffix
	if global {
		return filepath.Join("/tmp", "project-"+base), nil
	}
	return filepath.Join("tmp", base), nil
}

func randomSuffix() (string, error) {
	bytes := make([]byte, 4)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate tmp project suffix: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	if !strings.ContainsAny(value, " \t\n'\"\\$&;()[]{}!*?<>|`") {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
