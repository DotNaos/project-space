package projectvalidator

import (
	"path/filepath"
	"testing"
)

func TestValidateProjectTreatsWaivedUnknownFileAsTrackedDebt(t *testing.T) {
	templateRoot := writeAdoptionTestTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	createValidAdoptionTestProject(t, projectRoot, templateRoot)
	mustWriteFile(t, filepath.Join(projectRoot, "src", "main.go"), "package main\n")
	if _, err := AddAdoptionWaiver(projectRoot, "src/**", "legacy app layout", AdoptionWaiverOptions{Apply: true, Today: "2026-07-04"}); err != nil {
		t.Fatalf("AddAdoptionWaiver returned error: %v", err)
	}

	report, err := ValidateProject(projectRoot)
	if err != nil {
		t.Fatalf("ValidateProject returned error: %v", err)
	}
	if !report.OK {
		t.Fatal("waived unknown file should not fail validation")
	}
	assertFileValidation(t, report.Files, "src/main.go", StatusWaived)
}

func TestValidateProjectTreatsWaivedTemplateDriftAsTrackedDebt(t *testing.T) {
	templateRoot := writeAdoptionTestTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	createValidAdoptionTestProject(t, projectRoot, templateRoot)
	mustWriteFile(t, filepath.Join(projectRoot, "README.md"), "# changed\n")
	if _, err := AddAdoptionWaiver(projectRoot, "README.md", "custom readme during migration", AdoptionWaiverOptions{Apply: true, Today: "2026-07-04"}); err != nil {
		t.Fatalf("AddAdoptionWaiver returned error: %v", err)
	}

	report, err := ValidateProject(projectRoot)
	if err != nil {
		t.Fatalf("ValidateProject returned error: %v", err)
	}
	if !report.OK {
		t.Fatal("waived template drift should not fail validation")
	}
	assertFileValidation(t, report.Files, "README.md", StatusWaived)
}

func TestValidateProjectBlockerBeatsManualWaiver(t *testing.T) {
	templateRoot := writeAdoptionTestTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	createValidAdoptionTestProject(t, projectRoot, templateRoot)
	mustWriteFile(t, filepath.Join(projectRoot, ".env"), "DATABASE_URL=postgres://example\n")
	lock, err := readTemplateLock(projectRoot)
	if err != nil {
		t.Fatalf("readTemplateLock returned error: %v", err)
	}
	lock.Waivers = append(lock.Waivers, AdoptionWaiver{Path: ".env", Reason: "manual bad waiver", Added: "2026-07-04"})
	if _, err := writeTemplateLock(projectRoot, lock); err != nil {
		t.Fatalf("writeTemplateLock returned error: %v", err)
	}

	report, err := ValidateProject(projectRoot)
	if err != nil {
		t.Fatalf("ValidateProject returned error: %v", err)
	}
	if report.OK {
		t.Fatal("blocker should fail validation even when manually waived")
	}
	assertFileValidation(t, report.Files, ".env", StatusViolation)
}

func TestValidateProjectFileTreatsWaiverAsTrackedDebt(t *testing.T) {
	templateRoot := writeAdoptionTestTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	createValidAdoptionTestProject(t, projectRoot, templateRoot)
	mustWriteFile(t, filepath.Join(projectRoot, "src", "main.go"), "package main\n")
	if _, err := AddAdoptionWaiver(projectRoot, "src/**", "legacy app layout", AdoptionWaiverOptions{Apply: true, Today: "2026-07-04"}); err != nil {
		t.Fatalf("AddAdoptionWaiver returned error: %v", err)
	}

	file, err := ValidateProjectFile(projectRoot, "src/main.go")
	if err != nil {
		t.Fatalf("ValidateProjectFile returned error: %v", err)
	}
	if file.Status != StatusWaived {
		t.Fatalf("file status = %s, want %s", file.Status, StatusWaived)
	}
}

func createValidAdoptionTestProject(t *testing.T, projectRoot string, templateRoot string) {
	t.Helper()
	if _, err := CreateProject(projectRoot, InitOptions{TemplatePath: templateRoot}); err != nil {
		t.Fatalf("CreateProject returned error: %v", err)
	}
	if _, err := WriteTmpTemplateValues(projectRoot); err != nil {
		t.Fatalf("WriteTmpTemplateValues returned error: %v", err)
	}
	if _, err := InstallDefaultModules(projectRoot); err != nil {
		t.Fatalf("InstallDefaultModules returned error: %v", err)
	}
}

func assertFileValidation(t *testing.T, files []FileValidation, path string, status Status) {
	t.Helper()
	for _, file := range files {
		if file.Path == path {
			if file.Status != status {
				t.Fatalf("%s status = %s, want %s", path, file.Status, status)
			}
			return
		}
	}
	t.Fatalf("missing validation file %s", path)
}
