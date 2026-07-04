package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/DotNaos/project-space/internal/projectvalidator"
)

func TestAdoptCommandPrintsJSONDryRun(t *testing.T) {
	templateRoot := writeAdoptCommandTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	if _, err := projectvalidator.InitProject(projectRoot, projectvalidator.InitOptions{TemplatePath: templateRoot}); err != nil {
		t.Fatalf("InitProject returned error: %v", err)
	}
	mustWriteCommandTestFile(t, filepath.Join(projectRoot, "README.md"), "# changed\n")

	cmd := newRootCommand()
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	cmd.SetArgs([]string{"adopt", projectRoot, "--format", "json"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("adopt command returned error: %v\nstderr:\n%s", err, stderr.String())
	}
	var plan projectvalidator.AdoptionPlan
	if err := json.Unmarshal(stdout.Bytes(), &plan); err != nil {
		t.Fatalf("adopt command did not print JSON: %v\n%s", err, stdout.String())
	}
	if plan.WouldWrite {
		t.Fatal("adopt dry-run should report no writes")
	}
	if plan.Summary.Drift != 1 {
		t.Fatalf("drift count = %d, want 1", plan.Summary.Drift)
	}
}

func TestAdoptCommandAppliesWaiverAsJSON(t *testing.T) {
	templateRoot := writeAdoptCommandTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	if _, err := projectvalidator.InitProject(projectRoot, projectvalidator.InitOptions{TemplatePath: templateRoot}); err != nil {
		t.Fatalf("InitProject returned error: %v", err)
	}
	mustWriteCommandTestFile(t, filepath.Join(projectRoot, "src", "main.go"), "package main\n")

	cmd := newRootCommand()
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	cmd.SetArgs([]string{"adopt", projectRoot, "--waive", "src/**", "--reason", "legacy app layout", "--yes", "--format", "json"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("adopt waiver command returned error: %v\nstderr:\n%s", err, stderr.String())
	}
	var plan projectvalidator.AdoptionWaiverPlan
	if err := json.Unmarshal(stdout.Bytes(), &plan); err != nil {
		t.Fatalf("adopt waiver command did not print one JSON object: %v\n%s", err, stdout.String())
	}
	if plan.LockPath == "" {
		t.Fatal("applied waiver should report lock path")
	}

	adoption, err := projectvalidator.PlanAdoption(projectRoot)
	if err != nil {
		t.Fatalf("PlanAdoption returned error: %v", err)
	}
	if adoption.Summary.Waived != 1 {
		t.Fatalf("waived count = %d, want 1", adoption.Summary.Waived)
	}
}

func writeAdoptCommandTemplate(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mustWriteCommandTestFile(t, filepath.Join(root, ".templateignore"), ".templateignore\ntemplate/**\n")
	mustWriteCommandTestFile(t, filepath.Join(root, "template", "manifest.yaml"), "name: project-template\nversion: 0.1.0\nmodules:\n  - modules/core.yaml\n")
	mustWriteCommandTestFile(t, filepath.Join(root, "template", "modules", "core.yaml"), "name: core.fullstack\ndefault: true\nvalues:\n  project.slug:\n    type: string\n    required: true\nowns:\n  - README.md\n")
	mustWriteCommandTestFile(t, filepath.Join(root, "README.md.template"), "# {{ project.slug }}\n")
	return root
}

func mustWriteCommandTestFile(t *testing.T, path string, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
