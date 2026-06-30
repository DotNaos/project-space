package projectvalidator

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInitProjectCreatesLocalTemplateState(t *testing.T) {
	templateRoot := writeTestTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")

	lockPath, err := InitProject(projectRoot, InitOptions{TemplatePath: templateRoot})
	if err != nil {
		t.Fatalf("InitProject returned error: %v", err)
	}
	if _, err := os.Stat(lockPath); err != nil {
		t.Fatalf("template lock was not written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".project", "template", "template", "manifest.yaml")); err != nil {
		t.Fatalf("local template snapshot was not written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".project", "template.values.yaml")); err != nil {
		t.Fatalf("template values file was not written: %v", err)
	}

	lock, err := readTemplateLock(projectRoot)
	if err != nil {
		t.Fatalf("readTemplateLock returned error: %v", err)
	}
	checksum, err := checksumTemplateRoot(filepath.Join(projectRoot, ".project", "template"))
	if err != nil {
		t.Fatalf("checksumTemplateRoot returned error: %v", err)
	}
	if lock.Checksum != checksum {
		t.Fatalf("lock checksum = %q, want %q", lock.Checksum, checksum)
	}
}

func TestInstallModuleFillsMissingTemplateValues(t *testing.T) {
	templateRoot := writeTestTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	if _, err := InitProject(projectRoot, InitOptions{TemplatePath: templateRoot}); err != nil {
		t.Fatalf("InitProject returned error: %v", err)
	}

	if _, err := InstallModule(projectRoot, "core.fullstack", ModuleInstallOptions{Apply: true}); err != nil {
		t.Fatalf("InstallModule returned error: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(projectRoot, "README.md"))
	if err != nil {
		t.Fatalf("README.md was not written: %v", err)
	}
	if string(body) != "# demo-project\n" {
		t.Fatalf("README.md = %q", string(body))
	}
	values, err := readTemplateValues(projectRoot)
	if err != nil {
		t.Fatalf("readTemplateValues returned error: %v", err)
	}
	if got, ok := lookupTemplateValue(values, "project.slug"); !ok || got != "demo-project" {
		t.Fatalf("project.slug = %q, %t", got, ok)
	}
}

func writeTestTemplate(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "template", "manifest.yaml"), "name: project-template\nversion: 0.1.0\nmodules:\n  - modules/core.yaml\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "core.yaml"), "name: core.fullstack\ndescription: Core test module.\ndefault: true\nvalues:\n  project.slug:\n    type: string\n    required: true\nowns:\n  - README.md\n")
	mustWriteFile(t, filepath.Join(root, "README.md.template"), "# {{ project.slug }}\n")
	return root
}

func mustWriteFile(t *testing.T, path string, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
