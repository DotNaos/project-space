package projectvalidator

import (
	"strings"
	"testing"
)

func TestRenderTemplateValuesPreservesGitHubActionsExpressions(t *testing.T) {
	body := []byte("token: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}\nname: {{ project.slug }}\n")
	values := TemplateValues{"project": map[string]any{"slug": "demo"}}

	rendered, err := renderTemplateBody(body, values)
	if err != nil {
		t.Fatalf("renderTemplateBody returned error: %v", err)
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
	_, err := renderTemplateBody([]byte("name: {{ project.slug }}\n"), TemplateValues{})
	if err == nil {
		t.Fatal("expected missing template value error")
	}
	if !strings.Contains(err.Error(), `missing template value "project.slug"`) {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRenderTemplateValuesUsesYAMLLoadedNestedValues(t *testing.T) {
	var values TemplateValues
	if err := unmarshalYAML([]byte("project:\n  slug: demo-app\n"), &values); err != nil {
		t.Fatalf("unmarshalYAML returned error: %v", err)
	}

	rendered, err := renderTemplateBody([]byte("url: https://{{ project.slug }}.localhost.direct\n"), values)
	if err != nil {
		t.Fatalf("renderTemplateBody returned error: %v", err)
	}
	if got := string(rendered); got != "url: https://demo-app.localhost.direct\n" {
		t.Fatalf("rendered = %q", got)
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

func TestDefaultTemplateValuesResolveTransformsAndChains(t *testing.T) {
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
					"project.name": {
						Type:        "string",
						Required:    true,
						DefaultFrom: "project.displayName",
					},
					"project.displayName": {
						Type:        "string",
						Required:    true,
						DefaultFrom: "project.slug",
						Transform:   "title",
					},
					"project.packageName": {
						Type:        "string",
						Required:    true,
						DefaultFrom: "project.slug",
					},
				},
			},
		},
	}

	values, err := defaultTemplateValuesForProject("/tmp/demo-project", template, []string{"core.fullstack"})
	if err != nil {
		t.Fatalf("defaultTemplateValuesForProject returned error: %v", err)
	}
	if got, ok := lookupTemplateValue(values, "project.displayName"); !ok || got != "Demo Project" {
		t.Fatalf("project.displayName = %q, %t", got, ok)
	}
	if got, ok := lookupTemplateValue(values, "project.name"); !ok || got != "Demo Project" {
		t.Fatalf("project.name = %q, %t", got, ok)
	}
	if got, ok := lookupTemplateValue(values, "project.packageName"); !ok || got != "demo-project" {
		t.Fatalf("project.packageName = %q, %t", got, ok)
	}
}

func TestDefaultTemplateValuesReportsDefaultFromCycles(t *testing.T) {
	template := TemplateSpec{
		Modules: map[string]TemplateModuleSpec{
			"core.fullstack": {
				Name:    "core.fullstack",
				Default: true,
				Values: map[string]TemplateValueSpec{
					"project.name": {
						Type:        "string",
						Required:    true,
						DefaultFrom: "project.displayName",
					},
					"project.displayName": {
						Type:        "string",
						Required:    true,
						DefaultFrom: "project.name",
					},
				},
			},
		},
	}

	_, err := defaultTemplateValuesForProject("/tmp/demo-project", template, []string{"core.fullstack"})
	if err == nil {
		t.Fatal("expected defaultFrom cycle error")
	}
	if !strings.Contains(err.Error(), "defaultFrom cycle") {
		t.Fatalf("unexpected error: %v", err)
	}
}
