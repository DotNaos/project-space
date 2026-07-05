package main

import (
	"fmt"
	"sort"
	"strings"
)

func deploySteps(project deployProject, options deployOptions) []string {
	remotePath := shellQuote(project.RemotePath)
	return []string{
		"set -e; docker --version; docker compose version; docker info >/dev/null",
		"set -e; docker network inspect traefik-public >/dev/null",
		fmt.Sprintf("set -e; sudo -n mkdir -p %s; sudo -n chown $(id -u):$(id -g) %s", remotePath, remotePath),
		fmt.Sprintf("set -e; if [ -d %s/.git ]; then cd %s && git fetch origin %s && git reset --hard origin/%s; else git clone --branch %s %s %s; fi", remotePath, remotePath, shellQuote(project.Branch), shellQuote(project.Branch), shellQuote(project.Branch), shellQuote(project.RemoteURL), remotePath),
		composeUpStep(project, options),
		composeStatusStep(project, options),
	}
}

func composeUpStep(project deployProject, options deployOptions) string {
	return fmt.Sprintf(
		"set -e; cd %s; cat > .env <<'PROJECT_SPACE_ENV'\n%s\nPROJECT_SPACE_ENV\ndocker compose --env-file .env -p %s -f deploy/compose.yml -f deploy/ingress.labels.yml up -d --build",
		shellQuote(project.RemotePath),
		deployEnvFileContent(project, options, false),
		shellQuote(project.ComposeProject),
	)
}

func composeStatusStep(project deployProject, options deployOptions) string {
	return fmt.Sprintf("set -e; cd %s; docker compose --env-file .env -p %s -f deploy/compose.yml -f deploy/ingress.labels.yml ps", shellQuote(project.RemotePath), shellQuote(project.ComposeProject))
}

func deployStatusEnv(project deployProject, options deployOptions) string {
	parts := []string{
		"PROJECT_ENV=" + shellQuote(project.Environment),
		"PROJECT_COMPOSE_NAME=" + shellQuote(project.ComposeProject),
		"PROJECT_DOMAIN=" + shellQuote(options.ProjectDomain),
		"PROJECT_API_DOMAIN=" + shellQuote(options.APIDomain),
	}
	if options.AcmeEmail != "" {
		parts = append(parts, "TRAEFIK_ACME_EMAIL="+shellQuote(options.AcmeEmail))
	}
	return strings.Join(parts, " ")
}

func deployEnvFileContent(project deployProject, options deployOptions, includeSecretValues bool) string {
	secretValue := func(secret deploySecretValue) string {
		if includeSecretValues {
			return secret.Value
		}
		return secretSourceLabel(secret.Source)
	}

	lines := []string{
		"PROJECT_ENV=" + project.Environment,
		"PROJECT_COMPOSE_NAME=" + project.ComposeProject,
		"PROJECT_DOMAIN=" + options.ProjectDomain,
		"PROJECT_API_DOMAIN=" + options.APIDomain,
	}
	if options.AcmeEmail != "" {
		lines = append(lines, "TRAEFIK_ACME_EMAIL="+options.AcmeEmail)
	}
	names := make([]string, 0, len(options.Secrets))
	for name := range options.Secrets {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		lines = append(lines, name+"="+secretValue(options.Secrets[name]))
	}
	return strings.Join(lines, "\n")
}

func secretSourceLabel(source string) string {
	if source == "" {
		return "<secret>"
	}
	return "<secret from " + source + ">"
}

func deployComposeScript(project deployProject, options deployOptions, up bool) string {
	command := fmt.Sprintf("docker compose --env-file .env -p %s -f deploy/compose.yml -f deploy/ingress.labels.yml ps", shellQuote(project.ComposeProject))
	if up {
		command = fmt.Sprintf("docker compose --env-file .env -p %s -f deploy/compose.yml -f deploy/ingress.labels.yml up -d --build", shellQuote(project.ComposeProject))
	}
	return strings.Join([]string{
		"set -e",
		"cd " + shellQuote(project.RemotePath),
		"cat > .env <<'PROJECT_SPACE_ENV'",
		deployEnvFileContent(project, options, true),
		"PROJECT_SPACE_ENV",
		command,
	}, "\n")
}

func runRemoteScript(host string, script string) (string, error) {
	return runCommand("", []byte(script), "ssh", host, "sh", "-s")
}
