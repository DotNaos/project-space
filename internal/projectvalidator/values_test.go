package projectvalidator

import (
	"strings"
	"testing"
)

func TestRenderTemplateValuesPreservesGitHubActionsExpressions(t *testing.T) {
	body := []byte("token: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}\nname: {{ project.slug }}\n")
	values := TemplateValues{"project": map[string]any{"slug": "demo"}}

	rendered, err := renderTemplateValues(body, values)
	if err != nil {
		t.Fatalf("renderTemplateValues returned error: %v", err)
	}

	got := string(rendered)
	if !strings.Contains(got, "token: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}") {
		t.Fatalf("GitHub Actions expression was not preserved:\n%s", got)
	}
	if !strings.Contains(got, "name: demo") {
		t.Fatalf("project placeholder was not rendered:\n%s", got)
	}
}

func TestRenderTemplateValuesReportsMissingProjectValues(t *testing.T) {
	_, err := renderTemplateValues([]byte("name: {{ project.slug }}\n"), TemplateValues{})
	if err == nil {
		t.Fatal("expected missing template value error")
	}
	if !strings.Contains(err.Error(), `missing template value "project.slug"`) {
		t.Fatalf("unexpected error: %v", err)
	}
}
