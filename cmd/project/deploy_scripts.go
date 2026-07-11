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
	return strings.Join([]string{
		"set -e",
		"cd " + shellQuote(project.RemotePath),
		deployEnvFileWriteScript(project, options, false),
		fmt.Sprintf(
			"docker compose --env-file .env -p %s -f deploy/compose.yml -f deploy/ingress.labels.yml up -d --build",
			shellQuote(project.ComposeProject),
		),
	}, "\n")
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
		"PROJECT_SPACE_BUILD_NAME=" + project.Name,
		"PROJECT_SPACE_BUILD_VERSION=" + project.BuildVersion,
		"PROJECT_SPACE_BUILD_COMMIT=" + project.BuildCommit,
		"PROJECT_SPACE_BUILD_REF=" + project.BuildRef,
		"PROJECT_SPACE_BUILD_TIME=" + project.BuildTime,
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

func deployEnvFileWriteScript(
	project deployProject,
	options deployOptions,
	includeSecretValues bool,
) string {
	return strings.Join([]string{
		"umask 077",
		`project_env_tmp="$(mktemp .env.tmp.XXXXXX)"`,
		`cleanup_project_env() { [ -z "$project_env_tmp" ] || rm -f -- "$project_env_tmp"; }`,
		"trap cleanup_project_env 0",
		`trap 'cleanup_project_env; exit 1' 1 2 15`,
		`cat > "$project_env_tmp" <<'PROJECT_SPACE_ENV'`,
		deployEnvFileContent(project, options, includeSecretValues),
		"PROJECT_SPACE_ENV",
		`chmod 600 "$project_env_tmp"`,
		`mv -f -- "$project_env_tmp" .env`,
		"project_env_tmp=",
		"trap - 1 2 15",
	}, "\n")
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
		deployEnvFileWriteScript(project, options, true),
		command,
	}, "\n")
}

func runRemoteScript(host string, script string) (string, error) {
	return runCommand("", []byte(script), "ssh", host, "sh", "-s")
}
