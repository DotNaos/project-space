package projectrun

import (
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
)

var dnsLabelPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

func NormalizeAllowedHosts(hosts []string) ([]string, error) {
	seen := map[string]bool{}
	result := make([]string, 0, len(hosts))
	for _, candidate := range hosts {
		host := strings.ToLower(strings.TrimSpace(candidate))
		if err := validateAllowedHost(host); err != nil {
			return nil, fmt.Errorf("invalid allowed host %q: %w", candidate, err)
		}
		if !seen[host] {
			seen[host] = true
			result = append(result, host)
		}
	}
	sort.Strings(result)
	return result, nil
}

func validateAllowedHost(host string) error {
	if host == "" {
		return fmt.Errorf("host must not be empty")
	}
	if net.ParseIP(host) != nil {
		return nil
	}
	if strings.HasPrefix(host, ".") {
		return fmt.Errorf("host suffixes are not allowed; name each trusted host explicitly")
	}
	if strings.ContainsAny(host, "*,/:?#@\\\r\n\t ") || strings.Contains(host, "..") {
		return fmt.Errorf("use a hostname without scheme, port, path, wildcard, or comma")
	}
	labels := strings.Split(host, ".")
	for _, label := range labels {
		if !dnsLabelPattern.MatchString(label) {
			return fmt.Errorf("hostname label %q is invalid", label)
		}
	}
	return nil
}

func commandFor(script Script, directory, host string, port int, allowedHosts []string) Command {
	portValue := fmt.Sprintf("%d", port)
	argv := make([]string, len(script.Command))
	for index, argument := range script.Command {
		argument = strings.ReplaceAll(argument, "{host}", host)
		argv[index] = strings.ReplaceAll(argument, "{port}", portValue)
	}
	replacements := map[string]string{
		"PROJECT_HOST": host,
		"PROJECT_PORT": portValue,
		"PWD":          directory,
	}
	for key, value := range script.Environment {
		replacements[key] = value
	}
	for key, reference := range script.SecretEnvironment {
		replacements[key] = reference
	}
	if allowedHosts != nil {
		replacements["PROJECT_ALLOWED_HOSTS"] = strings.Join(allowedHosts, ",")
		replacements["__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"] = ""
		// Vite treats this compatibility variable as exactly one host. Passing
		// a comma-separated list creates one invalid literal hostname.
		// Projects that support multiple hosts read PROJECT_ALLOWED_HOSTS.
		if len(allowedHosts) == 1 {
			replacements["__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"] = allowedHosts[0]
		}
	}
	env := mergeEnvironment(nil, replacements)
	if len(script.SecretEnvironment) > 0 {
		argv = append([]string{"op", "run", "--"}, argv...)
	}
	return Command{Argv: argv, Dir: directory, Env: env}
}

func serverCommandFor(
	script Script,
	directory string,
	host string,
	port int,
	allowedHosts []string,
	mode ServeMode,
	portlessURL string,
) Command {
	command := commandFor(script, directory, host, port, allowedHosts)
	command.Env = mergeEnvironment(command.Env, map[string]string{
		"PROJECT_SPACE_MANAGED_SERVE": "1",
		"PROJECT_SPACE_SERVE_MODE":    string(mode),
		"PORTLESS_URL":                portlessURL,
	})
	return command
}

func mergeEnvironment(base []string, replacements map[string]string) []string {
	keys := make(map[string]bool, len(replacements))
	for key := range replacements {
		keys[key] = true
	}
	result := make([]string, 0, len(base)+len(replacements))
	for _, entry := range base {
		key, _, ok := strings.Cut(entry, "=")
		if !ok || keys[key] {
			continue
		}
		result = append(result, entry)
	}
	ordered := make([]string, 0, len(replacements))
	for key := range replacements {
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	for _, key := range ordered {
		result = append(result, key+"="+replacements[key])
	}
	return result
}
