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

func TestDefaultTemplateValuesUseModuleValueSpecs(t *testing.T) {
	template := TemplateSpec{
		Modules: map[string]TemplateModuleSpec{
			"core.fullstack": {
				Name:    "core.fullstack",
				Default: true,
				Values: map[string]TemplateValueSpec{
					"project.slug": {
						Type:     "string",
						Required: true,
					},
					"project.goModule": {
						Type:     "string",
						Required: true,
						Default:  "github.com/DotNaos/{{ project.slug }}",
					},
				},
			},
		},
	}

	values, err := defaultTemplateValuesForProject("/tmp/demo-project", template, []string{"core.fullstack"})
	if err != nil {
		t.Fatalf("defaultTemplateValuesForProject returned error: %v", err)
	}
	if got, ok := lookupTemplateValue(values, "project.slug"); !ok || got != "demo-project" {
		t.Fatalf("project.slug = %q, %t", got, ok)
	}
	if got, ok := lookupTemplateValue(values, "project.goModule"); !ok || got != "github.com/DotNaos/demo-project" {
		t.Fatalf("project.goModule = %q, %t", got, ok)
	}
	if _, ok := lookupTemplateValue(values, "project.displayName"); ok {
		t.Fatal("project.displayName should not be written when no installed module declares it")
	}
}
