package projectrun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type LocalRouter interface {
	Register(context.Context, string, int) (string, error)
	Matches(context.Context, string, string, int) (bool, error)
	Remove(context.Context, string, string, int) error
}

type PortlessCLI struct {
	Executable string
	Run        func(context.Context, string, ...string) (string, error)
}

type portlessRoute struct {
	URL  string
	Port int
	Kind string
}

var portlessRouteLine = regexp.MustCompile(
	`^\s+(https?://\S+)\s+->\s+localhost:([0-9]+)\s+\((alias|pid [0-9]+)\)\s*$`,
)

var issueWorktreeLabel = regexp.MustCompile(`^(?:task-)?issue-([0-9]+(?:-|$).*)$`)

func (portless PortlessCLI) Register(ctx context.Context, name string, port int) (string, error) {
	if err := validatePortlessName(name); err != nil {
		return "", err
	}
	if err := validateRuntimePort("Portless target", port); err != nil || port == 0 {
		return "", fmt.Errorf("Portless target port is invalid")
	}
	if _, err := portless.output(ctx, "proxy", "start"); err != nil {
		return "", fmt.Errorf("start Portless proxy: %w", err)
	}
	routeURL, err := portless.routeURL(ctx, name)
	if err != nil {
		return "", err
	}
	routes, err := portless.routes(ctx)
	if err != nil {
		return "", err
	}
	if _, exists := routes[routeURL]; exists {
		return "", fmt.Errorf("refusing to replace existing Portless route %s", routeURL)
	}
	if _, err := portless.output(ctx, "alias", name, strconv.Itoa(port)); err != nil {
		return "", fmt.Errorf("register Portless route %s: %w", routeURL, err)
	}
	matches, err := portless.Matches(ctx, name, routeURL, port)
	if err != nil || !matches {
		cause := err
		if cause == nil {
			cause = fmt.Errorf("Portless did not retain the exact alias target")
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		cleanupErr := portless.Remove(cleanupCtx, name, routeURL, port)
		cancel()
		return "", errors.Join(cause, cleanupErr)
	}
	return routeURL, nil
}

func (portless PortlessCLI) Matches(
	ctx context.Context,
	name string,
	routeURL string,
	port int,
) (bool, error) {
	if err := validatePortlessRoute(name, routeURL); err != nil {
		return false, err
	}
	routes, err := portless.routes(ctx)
	if err != nil {
		return false, err
	}
	route, exists := routes[routeURL]
	return exists && route.Kind == "alias" && route.Port == port, nil
}

func (portless PortlessCLI) Remove(
	ctx context.Context,
	name string,
	routeURL string,
	port int,
) error {
	matches, err := portless.Matches(ctx, name, routeURL, port)
	if err != nil {
		return err
	}
	if !matches {
		routes, listErr := portless.routes(ctx)
		if listErr != nil {
			return listErr
		}
		if _, exists := routes[routeURL]; exists {
			return fmt.Errorf("refusing to remove Portless route %s because its target or owner changed", routeURL)
		}
		return nil
	}
	if _, err := portless.output(ctx, "alias", "--remove", name); err != nil {
		return fmt.Errorf("remove Portless route %s: %w", routeURL, err)
	}
	routes, err := portless.routes(ctx)
	if err != nil {
		return err
	}
	if _, exists := routes[routeURL]; exists {
		return fmt.Errorf("Portless route %s still exists after removal", routeURL)
	}
	return nil
}

func (portless PortlessCLI) routeURL(ctx context.Context, name string) (string, error) {
	body, err := portless.output(ctx, "get", "--no-worktree", name)
	if err != nil {
		return "", fmt.Errorf("resolve Portless URL: %w", err)
	}
	routeURL := strings.TrimSpace(body)
	if err := validatePortlessRoute(name, routeURL); err != nil {
		return "", err
	}
	return routeURL, nil
}

func (portless PortlessCLI) routes(ctx context.Context) (map[string]portlessRoute, error) {
	body, err := portless.output(ctx, "list")
	if err != nil {
		return nil, fmt.Errorf("list Portless routes: %w", err)
	}
	routes := map[string]portlessRoute{}
	for _, line := range strings.Split(body, "\n") {
		match := portlessRouteLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		port, parseErr := strconv.Atoi(match[2])
		if parseErr != nil || port < 1 || port > 65535 {
			return nil, fmt.Errorf("Portless returned an invalid route target")
		}
		routes[match[1]] = portlessRoute{URL: match[1], Port: port, Kind: match[3]}
	}
	return routes, nil
}

func (portless PortlessCLI) output(ctx context.Context, args ...string) (string, error) {
	name := portless.Executable
	if name == "" {
		name = "portless"
	}
	if portless.Run != nil {
		return portless.Run(ctx, name, args...)
	}
	return runOutput(ctx, name, args...)
}

func portlessName(identity ServerIdentity) string {
	repository := filepath.Base(filepath.Dir(identity.RepositoryPath))
	if filepath.Base(identity.RepositoryPath) != ".git" {
		repository = filepath.Base(identity.RepositoryPath)
	}
	repository = portlessLabel(repository)
	worktree := portlessWorktreeLabel(filepath.Base(identity.WorktreePath))
	base := repository
	if worktree != repository {
		base = worktree + "." + repository
	}
	if identity.ServerKey != "dev" {
		base = portlessLabel(identity.ServerKey) + "." + base
	}
	return base
}

func portlessWorktreeLabel(value string) string {
	label := strings.Trim(identitySegmentPattern.ReplaceAllString(strings.ToLower(value), "-"), "-")
	if match := issueWorktreeLabel.FindStringSubmatch(label); match != nil {
		label = match[1]
	}
	return portlessLabel(label)
}

func portlessLabel(value string) string {
	label := strings.Trim(identitySegmentPattern.ReplaceAllString(strings.ToLower(value), "-"), "-")
	if label == "" {
		label = "server"
	}
	if len(label) <= 63 {
		return label
	}
	digest := sha256.Sum256([]byte(label))
	suffix := hex.EncodeToString(digest[:4])
	return strings.TrimRight(label[:54], "-") + "-" + suffix
}

func validatePortlessName(name string) error {
	if name == "" || len(name) > 253 || strings.ContainsAny(name, "\x00\r\n") {
		return fmt.Errorf("Portless route name is invalid")
	}
	for _, label := range strings.Split(name, ".") {
		if !dnsLabelPattern.MatchString(label) {
			return fmt.Errorf("Portless route label %q is invalid", label)
		}
	}
	return nil
}

func validatePortlessRoute(name, routeURL string) error {
	if err := validatePortlessName(name); err != nil {
		return err
	}
	parsed, err := url.Parse(routeURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Hostname() != name+".localhost" || parsed.Port() == "" || parsed.Path != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return fmt.Errorf("Portless returned an invalid URL for route %q", name)
	}
	return nil
}

func probeTargetForURL(routeURL, path string) (ProbeTarget, error) {
	parsed, err := url.Parse(routeURL)
	if err != nil {
		return ProbeTarget{}, err
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 {
		return ProbeTarget{}, fmt.Errorf("route URL has no valid port")
	}
	return ProbeTarget{Scheme: parsed.Scheme, Host: parsed.Hostname(), Port: port, Path: path}, nil
}
