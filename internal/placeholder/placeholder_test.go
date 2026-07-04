package placeholder

import (
	"errors"
	"strings"
	"testing"
)

func TestRenderAndRegexAgree(t *testing.T) {
	body := []byte("name={{ project.slug }}\nurl=https://{{ project.domain }}/{{ project.slug }}\n")
	values := Values{"project": map[string]any{"slug": "demo-app", "domain": "example.test"}}
	slotPatterns := map[string]string{
		"project.slug":   `[a-z0-9-]+`,
		"project.domain": `[a-z.]+`,
	}

	template, err := Parse(body)
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	rendered, err := template.Render(values)
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}
	regex, names, err := template.ToRegex(slotPatterns)
	if err != nil {
		t.Fatalf("ToRegex returned error: %v", err)
	}

	if !regex.Match(rendered) {
		t.Fatalf("regex did not match rendered body:\n%s", rendered)
	}
	if got := strings.Join(names, ","); got != "project.slug,project.domain,project.slug" {
		t.Fatalf("placeholder order = %q", got)
	}
}

func TestRenderAndRegexAgreeForCorpus(t *testing.T) {
	values := Values{
		"project": map[string]any{
			"slug":   "demo-app",
			"domain": "example.test",
			"port":   8080,
		},
		"deploy": map[string]any{
			"env": "production",
		},
	}
	slotPatterns := map[string]string{
		"project.slug":   `[a-z0-9-]+`,
		"project.domain": `[a-z.]+`,
		"project.port":   `[0-9]+`,
		"deploy.env":     `production|staging`,
	}
	cases := []struct {
		name string
		body string
	}{
		{
			name: "plain text",
			body: "no placeholders here\n",
		},
		{
			name: "repeated placeholders",
			body: "{{ project.slug }}/{{ project.slug }}/{{ deploy.env }}\n",
		},
		{
			name: "surrounded placeholders",
			body: "url=https://{{ project.domain }}:{{ project.port }}/{{ project.slug }}\n",
		},
		{
			name: "escaped github expression",
			body: "ref=${{ github.ref }}\napp={{ project.slug }}\n",
		},
		{
			name: "multiline body",
			body: "service:\n  name: {{ project.slug }}\n  env: {{ deploy.env }}\n",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			template, err := Parse([]byte(testCase.body))
			if err != nil {
				t.Fatalf("Parse returned error: %v", err)
			}
			rendered, err := template.Render(values)
			if err != nil {
				t.Fatalf("Render returned error: %v", err)
			}
			regex, _, err := template.ToRegex(slotPatterns)
			if err != nil {
				t.Fatalf("ToRegex returned error: %v", err)
			}
			if !regex.Match(rendered) {
				t.Fatalf("regex did not match rendered body:\n%s", rendered)
			}
		})
	}
}

func TestDollarEscapesPlaceholderForRenderAndRegex(t *testing.T) {
	body := []byte("workflow: ${{ github.ref }}\nname: {{ project.slug }}\n")
	values := Values{"project": map[string]any{"slug": "demo"}}

	template, err := Parse(body)
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	rendered, err := template.Render(values)
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}
	if !strings.Contains(string(rendered), "workflow: ${{ github.ref }}") {
		t.Fatalf("escaped placeholder was not preserved:\n%s", rendered)
	}

	regex, names, err := template.ToRegex(map[string]string{"project.slug": `[a-z]+`})
	if err != nil {
		t.Fatalf("ToRegex returned error: %v", err)
	}
	if got := strings.Join(names, ","); got != "project.slug" {
		t.Fatalf("placeholder order = %q", got)
	}
	if !regex.Match(rendered) {
		t.Fatalf("regex did not match rendered body:\n%s", rendered)
	}
	if regex.Match([]byte("workflow: main\nname: demo\n")) {
		t.Fatal("regex treated escaped placeholder as a slot")
	}
}

func TestParseRejectsUnnamespacedPlaceholders(t *testing.T) {
	_, err := Parse([]byte("name: {{ slug }}\n"))
	if err == nil {
		t.Fatal("expected invalid placeholder error")
	}
	if !strings.Contains(err.Error(), "must be namespaced") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestToRegexReportsMissingSlotPattern(t *testing.T) {
	template, err := Parse([]byte("name: {{ project.slug }}\n"))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	_, _, err = template.ToRegex(map[string]string{})
	if err == nil {
		t.Fatal("expected missing slot regex error")
	}
	if !strings.Contains(err.Error(), `missing slot regex for placeholder "project.slug"`) {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRenderReportsStructuredMissingValue(t *testing.T) {
	template, err := Parse([]byte("name: {{ project.slug }}\n"))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	_, err = template.Render(Values{})
	if err == nil {
		t.Fatal("expected missing value error")
	}
	var missing MissingValueError
	if !errors.As(err, &missing) {
		t.Fatalf("expected MissingValueError, got %T: %v", err, err)
	}
	if missing.Name != "project.slug" {
		t.Fatalf("missing name = %q", missing.Name)
	}
}

func TestLiteralMissingSentinelTextIsPreserved(t *testing.T) {
	body := []byte("literal: \x00missing:project.slug\x00\nname: {{ project.slug }}\n")
	values := Values{"project": map[string]any{"slug": "demo"}}

	template, err := Parse(body)
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	rendered, err := template.Render(values)
	if err != nil {
		t.Fatalf("Render returned error: %v", err)
	}
	if !strings.Contains(string(rendered), "\x00missing:project.slug\x00") {
		t.Fatalf("literal sentinel text was changed:\n%q", rendered)
	}
}

func TestUnrenderReplacesLongestValuesFirst(t *testing.T) {
	body := []byte("module github.com/DotNaos/project-template/server\napp project-template\n")
	values := map[string]string{
		"project.slug":     "project-template",
		"project.goModule": "github.com/DotNaos/project-template",
	}

	got := string(Unrender(body, values))
	want := "module {{ project.goModule }}/server\napp {{ project.slug }}\n"
	if got != want {
		t.Fatalf("Unrender = %q, want %q", got, want)
	}
}

func TestUnrenderSkipsShortValues(t *testing.T) {
	body := []byte("a project-template\n")
	values := map[string]string{
		"project.short": "a",
		"project.slug":  "project-template",
	}

	got := string(Unrender(body, values))
	want := "a {{ project.slug }}\n"
	if got != want {
		t.Fatalf("Unrender = %q, want %q", got, want)
	}
}
