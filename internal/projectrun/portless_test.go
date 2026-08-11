package projectrun

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestPortlessNameMatchesReadableWorktreeConvention(t *testing.T) {
	tests := []struct {
		identity ServerIdentity
		want     string
	}{
		{
			identity: ServerIdentity{
				RepositoryPath: "/Users/oli/projects/project-space/.git",
				WorktreePath:   "/Users/oli/projects/project-space",
				ServerKey:      "dev",
			},
			want: "project-space",
		},
		{
			identity: ServerIdentity{
				RepositoryPath: "/Users/oli/projects/project-space/.git",
				WorktreePath:   "/Users/oli/projects/.worktrees/project-space/issue-612-managed-dev",
				ServerKey:      "dev",
			},
			want: "issue-612-managed-dev.project-space",
		},
		{
			identity: ServerIdentity{
				RepositoryPath: "/Users/oli/projects/project-space/.git",
				WorktreePath:   "/Users/oli/projects/.worktrees/project-space/issue-612-managed-dev",
				ServerKey:      "docs",
			},
			want: "docs.issue-612-managed-dev.project-space",
		},
	}
	for _, test := range tests {
		if got := portlessName(test.identity); got != test.want {
			t.Fatalf("Portless name = %q, want %q", got, test.want)
		}
	}
}

func TestPortlessLabelBoundsLongWorktreeNamesDeterministically(t *testing.T) {
	value := strings.Repeat("long-worktree-", 8)
	first, second := portlessLabel(value), portlessLabel(value)
	if first != second || len(first) > 63 || !strings.Contains(first, "-") {
		t.Fatalf("bounded label = %q / %q", first, second)
	}
}

func TestPortlessCLIRegistersVerifiesAndRemovesExactAlias(t *testing.T) {
	routes := map[string]int{}
	var calls [][]string
	run := func(_ context.Context, _ string, args ...string) (string, error) {
		calls = append(calls, append([]string{}, args...))
		switch strings.Join(args, " ") {
		case "proxy start":
			return "Proxy is already running on port 1355.\n", nil
		case "get --no-worktree issue-612.project-space":
			return "http://issue-612.project-space.localhost:1355\n", nil
		case "alias issue-612.project-space 43117":
			routes["http://issue-612.project-space.localhost:1355"] = 43117
			return "Alias registered\n", nil
		case "alias --remove issue-612.project-space":
			delete(routes, "http://issue-612.project-space.localhost:1355")
			return "Removed alias\n", nil
		case "list":
			body := "\nActive routes:\n\n"
			for routeURL, port := range routes {
				body += fmt.Sprintf("  %s  ->  localhost:%d  (alias)\n", routeURL, port)
			}
			return body, nil
		default:
			return "", fmt.Errorf("unexpected call: %v", args)
		}
	}
	portless := PortlessCLI{Run: run}
	routeURL, err := portless.Register(context.Background(), "issue-612.project-space", 43117)
	if err != nil {
		t.Fatal(err)
	}
	if routeURL != "http://issue-612.project-space.localhost:1355" {
		t.Fatalf("route URL = %q", routeURL)
	}
	if err := portless.Remove(context.Background(), "issue-612.project-space", routeURL, 43117); err != nil {
		t.Fatal(err)
	}
	if len(routes) != 0 || len(calls) < 7 {
		t.Fatalf("routes=%#v calls=%#v", routes, calls)
	}
}

func TestPortlessCLIRefusesForeignOrRepurposedRoutes(t *testing.T) {
	routeURL := "http://issue-612.project-space.localhost:1355"
	portless := PortlessCLI{Run: func(_ context.Context, _ string, args ...string) (string, error) {
		switch strings.Join(args, " ") {
		case "proxy start":
			return "", nil
		case "get --no-worktree issue-612.project-space":
			return routeURL + "\n", nil
		case "list":
			return "  " + routeURL + "  ->  localhost:49999  (pid 1234)\n", nil
		default:
			return "", fmt.Errorf("must not mutate foreign route: %v", args)
		}
	}}
	if _, err := portless.Register(context.Background(), "issue-612.project-space", 43117); err == nil ||
		!strings.Contains(err.Error(), "refusing to replace") {
		t.Fatalf("register error = %v", err)
	}
	if err := portless.Remove(context.Background(), "issue-612.project-space", routeURL, 43117); err == nil ||
		!strings.Contains(err.Error(), "owner changed") {
		t.Fatalf("remove error = %v", err)
	}
}

func TestParsePortlessRoutesIgnoresHeadingsAndPreservesKinds(t *testing.T) {
	output := "\nActive routes:\n\n" +
		"  http://one.localhost:1355  ->  localhost:43117  (alias)\n" +
		"  http://two.localhost:1355  ->  localhost:43118  (pid 77)\n"
	portless := PortlessCLI{Run: func(_ context.Context, _ string, args ...string) (string, error) {
		if !reflect.DeepEqual(args, []string{"list"}) {
			return "", fmt.Errorf("unexpected args: %v", args)
		}
		return output, nil
	}}
	routes, err := portless.routes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(routes) != 2 || routes["http://one.localhost:1355"].Kind != "alias" ||
		routes["http://two.localhost:1355"].Kind != "pid 77" {
		t.Fatalf("routes = %#v", routes)
	}
}
