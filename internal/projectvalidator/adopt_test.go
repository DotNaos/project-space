package projectvalidator

import (
	"path/filepath"
	"testing"
)

func TestPlanAdoptionClassifiesProjectFiles(t *testing.T) {
	templateRoot := writeAdoptionTestTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	if _, err := InitProject(projectRoot, InitOptions{TemplatePath: templateRoot}); err != nil {
		t.Fatalf("InitProject returned error: %v", err)
	}
	if _, err := WriteTmpTemplateValues(projectRoot); err != nil {
		t.Fatalf("WriteTmpTemplateValues returned error: %v", err)
	}
	mustWriteFile(t, filepath.Join(projectRoot, "README.md"), "# demo-project\n")
	mustWriteFile(t, filepath.Join(projectRoot, "package.json"), "{\"name\":\"changed\"}\n")
	mustWriteFile(t, filepath.Join(projectRoot, "extras", "note.md"), "local note\n")
	mustWriteFile(t, filepath.Join(projectRoot, "src", "main.go"), "package main\n")
	mustWriteFile(t, filepath.Join(projectRoot, "bun.lock"), "generated lock\n")
	mustWriteFile(t, filepath.Join(projectRoot, ".env"), "DATABASE_URL=postgres://example\n")

	plan, err := PlanAdoption(projectRoot)
	if err != nil {
		t.Fatalf("PlanAdoption returned error: %v", err)
	}
	if plan.WouldWrite {
		t.Fatal("adoption dry-run plan should not write")
	}
	assertAdoptionCount(t, plan.Summary.Match, 1, "match")
	assertAdoptionCount(t, plan.Summary.Drift, 1, "drift")
	assertAdoptionCount(t, plan.Summary.Missing, 1, "missing")
	assertAdoptionCount(t, plan.Summary.Slot, 1, "slot")
	assertAdoptionCount(t, plan.Summary.Blocker, 1, "blocker")
	assertAdoptionCount(t, plan.Summary.Unknown, 1, "unknown")
	assertAdoptionState(t, plan.Files, "README.md", "match")
	assertAdoptionState(t, plan.Files, "package.json", "drift")
	assertAdoptionState(t, plan.Files, "LICENSE", "missing")
	assertAdoptionState(t, plan.Files, "extras/note.md", "slot")
	assertAdoptionState(t, plan.Files, "src/main.go", "unknown")
	assertAdoptionState(t, plan.Files, ".env", "blocker")
	assertNoAdoptionFile(t, plan.Files, "bun.lock")

	if len(plan.Modules) != 1 {
		t.Fatalf("modules length = %d, want 1", len(plan.Modules))
	}
	module := plan.Modules[0]
	if module.Name != "core.fullstack" {
		t.Fatalf("module name = %q, want core.fullstack", module.Name)
	}
	assertAdoptionCount(t, module.Summary.Match, 1, "module match")
	assertAdoptionCount(t, module.Summary.Drift, 1, "module drift")
	assertAdoptionCount(t, module.Summary.Missing, 1, "module missing")
	assertAdoptionCount(t, module.Summary.Blocker, 1, "module blocker")
}

func TestAddAdoptionWaiverRecordsWaivedPath(t *testing.T) {
	templateRoot := writeAdoptionTestTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	if _, err := InitProject(projectRoot, InitOptions{TemplatePath: templateRoot}); err != nil {
		t.Fatalf("InitProject returned error: %v", err)
	}
	mustWriteFile(t, filepath.Join(projectRoot, "src", "main.go"), "package main\n")

	waiver, err := AddAdoptionWaiver(projectRoot, "src/**", "legacy app layout", AdoptionWaiverOptions{Apply: true, Today: "2026-07-04"})
	if err != nil {
		t.Fatalf("AddAdoptionWaiver returned error: %v", err)
	}
	if !waiver.WouldWrite {
		t.Fatal("waiver should report a write")
	}
	if waiver.LockPath == "" {
		t.Fatal("applied waiver should report lock path")
	}

	lock, err := readTemplateLock(projectRoot)
	if err != nil {
		t.Fatalf("readTemplateLock returned error: %v", err)
	}
	if len(lock.Waivers) != 1 {
		t.Fatalf("waivers length = %d, want 1", len(lock.Waivers))
	}
	if lock.Waivers[0].Path != "src/**" || lock.Waivers[0].Reason != "legacy app layout" || lock.Waivers[0].Added != "2026-07-04" {
		t.Fatalf("unexpected waiver: %#v", lock.Waivers[0])
	}

	plan, err := PlanAdoption(projectRoot)
	if err != nil {
		t.Fatalf("PlanAdoption returned error: %v", err)
	}
	assertAdoptionState(t, plan.Files, "src/main.go", "waived")
	assertAdoptionCount(t, plan.Summary.Waived, 1, "waived")
	assertAdoptionCount(t, plan.Summary.Unknown, 0, "unknown after waiver")
}

func TestAddAdoptionWaiverRejectsBlocker(t *testing.T) {
	templateRoot := writeAdoptionTestTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	if _, err := InitProject(projectRoot, InitOptions{TemplatePath: templateRoot}); err != nil {
		t.Fatalf("InitProject returned error: %v", err)
	}
	mustWriteFile(t, filepath.Join(projectRoot, ".env"), "DATABASE_URL=postgres://example\n")

	_, err := AddAdoptionWaiver(projectRoot, ".env", "keep plaintext env", AdoptionWaiverOptions{Apply: true, Today: "2026-07-04"})
	if err == nil {
		t.Fatal("expected blocker waiver error")
	}
}

func writeAdoptionTestTemplate(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, ".templateignore"), ".templateignore\ntemplate/**\n.slot.yaml\nbun.lock\n.env\n")
	mustWriteFile(t, filepath.Join(root, "template", "manifest.yaml"), "name: project-template\nversion: 0.1.0\nmodules:\n  - modules/core.yaml\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "core.yaml"), "name: core.fullstack\ndescription: Core test module.\ndefault: true\nvalues:\n  project.slug:\n    type: string\n    required: true\nblockers:\n  - path: .env\n    reason: plaintext secrets must move to 1Password references\nowns:\n  - README.md\n  - package.json\n  - LICENSE\n")
	mustWriteFile(t, filepath.Join(root, ".slot.yaml"), "name: root\nallow:\n  - extras/**\n")
	mustWriteFile(t, filepath.Join(root, "README.md.template"), "# {{ project.slug }}\n")
	mustWriteFile(t, filepath.Join(root, "package.json.template"), "{\"name\":\"{{ project.slug }}\"}\n")
	mustWriteFile(t, filepath.Join(root, "LICENSE"), "MIT\n")
	return root
}

func assertAdoptionCount(t *testing.T, got int, want int, label string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s count = %d, want %d", label, got, want)
	}
}

func assertAdoptionState(t *testing.T, files []AdoptionFile, path string, state string) {
	t.Helper()
	for _, file := range files {
		if file.Path == path {
			if file.State != state {
				t.Fatalf("%s state = %q, want %q", path, file.State, state)
			}
			return
		}
	}
	t.Fatalf("missing adoption file %s", path)
}

func assertNoAdoptionFile(t *testing.T, files []AdoptionFile, path string) {
	t.Helper()
	for _, file := range files {
		if file.Path == path {
			t.Fatalf("unexpected adoption file %s with state %s", path, file.State)
		}
	}
}
