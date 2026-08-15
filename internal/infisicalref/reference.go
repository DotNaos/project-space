package infisicalref

import (
	"fmt"
	"regexp"
	"strings"
)

const Prefix = "infisical://"

var (
	projectIDPattern   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	environmentPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	secretNamePattern  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

type Reference struct {
	ProjectID   string
	Environment string
	SecretName  string
}

func Parse(source string, expectedSecretName string) (Reference, error) {
	if strings.TrimSpace(source) != source || strings.ContainsAny(source, "\x00\r\n\t") {
		return Reference{}, fmt.Errorf("reference must be one trimmed line")
	}
	parts := strings.Split(strings.TrimPrefix(source, Prefix), "/")
	if !strings.HasPrefix(source, Prefix) || len(parts) != 3 {
		return Reference{}, fmt.Errorf("reference must use infisical://<project-id>/<environment>/<secret-name>")
	}
	reference := Reference{ProjectID: parts[0], Environment: parts[1], SecretName: parts[2]}
	if !projectIDPattern.MatchString(reference.ProjectID) {
		return Reference{}, fmt.Errorf("reference project ID is invalid")
	}
	if !environmentPattern.MatchString(reference.Environment) {
		return Reference{}, fmt.Errorf("reference environment is invalid")
	}
	if !secretNamePattern.MatchString(reference.SecretName) {
		return Reference{}, fmt.Errorf("reference secret name is invalid")
	}
	if expectedSecretName != "" && reference.SecretName != expectedSecretName {
		return Reference{}, fmt.Errorf("reference secret name must match %s", expectedSecretName)
	}
	return reference, nil
}
