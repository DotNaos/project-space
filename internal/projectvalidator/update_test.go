package projectvalidator

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlanTemplateUpdateValuesShowsAddedModuleValues(t *testing.T) {
	current := TemplateValues{
		"project": map[string]any{
			"slug": "demo-project",
		},
	}
	next := TemplateValues{
		"project": map[string]any{
			"slug":    "demo-project",
			"tagline": "Built from demo-project",
		},
	}

	changes := planTemplateUpdateValues(current, next)
	if len(changes) != 1 {
		t.Fatalf("expected 1 change, got %d: %#v", len(changes), changes)
	}
	change := changes[0]
	if change.Action != "ADD" || change.Key != "project.tagline" || change.After != "Built from demo-project" {
		t.Fatalf("unexpected change: %#v", change)
	}
}

func TestTemplateUpdateMigratesSplitModuleWithExplicitTarget(t *testing.T) {
	oldTemplateRoot := writeUpdateTestTemplate(t, "0.1.0", "title: {{ project.slug }}\n")
	newTemplateRoot := writeSplitModuleUpdateTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	if _, err := CreateProject(projectRoot, InitOptions{TemplatePath: oldTemplateRoot}); err != nil {
		t.Fatalf("CreateProject returned error: %v", err)
	}
	if _, err := WriteTmpTemplateValues(projectRoot); err != nil {
		t.Fatalf("WriteTmpTemplateValues returned error: %v", err)
	}
	if _, err := InstallDefaultModules(projectRoot); err != nil {
		t.Fatalf("InstallDefaultModules returned error: %v", err)
	}

	options := TemplateUpdateOptions{
		TemplatePath: newTemplateRoot,
		Targets:      []AppTargetSelection{{Target: "web", Devices: []string{"desktop", "mobile"}}},
	}
	plan, err := PlanTemplateUpdate(projectRoot, options)
	if err != nil {
		t.Fatalf("PlanTemplateUpdate returned error: %v", err)
	}
	if len(plan.FromModules) != 1 || plan.FromModules[0] != "core.fullstack" {
		t.Fatalf("unexpected source modules: %#v", plan.FromModules)
	}
	if got := strings.Join(plan.ToModules, ","); got != "core.shared,implementation.web.shared,target.web" {
		t.Fatalf("unexpected migrated modules: %s", got)
	}

	if _, err := ApplyTemplateUpdate(projectRoot, options); err != nil {
		t.Fatalf("ApplyTemplateUpdate returned error: %v", err)
	}
	lock, err := readTemplateLock(projectRoot)
	if err != nil {
		t.Fatalf("readTemplateLock returned error: %v", err)
	}
	if got := strings.Join(lock.Modules, ","); got != "core.shared,implementation.web.shared,target.web" {
		t.Fatalf("lock modules = %s", got)
	}
	values, err := readTemplateValues(projectRoot)
	if err != nil {
		t.Fatalf("readTemplateValues returned error: %v", err)
	}
	if value, ok := lookupTemplateValue(values, "app.targets.web"); !ok || value != "true" {
		t.Fatalf("app.targets.web = %q, present=%v", value, ok)
	}
}

func TestFlattenTemplateValuesHandlesNamedRootType(t *testing.T) {
	values := TemplateValues{
		"project": map[string]any{
			"slug": "demo-project",
		},
	}

	flat := flattenTemplateValues(values)
	if flat["project.slug"] != "demo-project" {
		t.Fatalf("project.slug = %q", flat["project.slug"])
	}
}

func TestApplyTemplateUpdateMergesIndependentLocalEdits(t *testing.T) {
	oldTemplateRoot := writeUpdateTestTemplate(t, "0.1.0", "title: {{ project.slug }}\nlocal: base\n\nupstream: old\n")
	newTemplateRoot := writeUpdateTestTemplate(t, "0.2.0", "title: {{ project.slug }}\nlocal: base\n\nupstream: new\n")
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	if _, err := CreateProject(projectRoot, InitOptions{TemplatePath: oldTemplateRoot}); err != nil {
		t.Fatalf("CreateProject returned error: %v", err)
	}
	if _, err := WriteTmpTemplateValues(projectRoot); err != nil {
		t.Fatalf("WriteTmpTemplateValues returned error: %v", err)
	}
	if _, err := InstallDefaultModules(projectRoot); err != nil {
		t.Fatalf("InstallDefaultModules returned error: %v", err)
	}
	mustWriteFile(t, filepath.Join(projectRoot, "README.md"), "title: demo-project\nlocal: user edit\n\nupstream: old\n")

	plan, err := PlanTemplateUpdate(projectRoot, TemplateUpdateOptions{TemplatePath: newTemplateRoot})
	if err != nil {
		t.Fatalf("PlanTemplateUpdate returned error: %v", err)
	}
	update := singleUpdateFileChange(t, plan, "README.md")
	if update.Result != "merged" {
		t.Fatalf("README.md update result = %q, want merged", update.Result)
	}

	if _, err := ApplyTemplateUpdate(projectRoot, TemplateUpdateOptions{TemplatePath: newTemplateRoot}); err != nil {
		t.Fatalf("ApplyTemplateUpdate returned error: %v", err)
	}
	body := mustReadFile(t, filepath.Join(projectRoot, "README.md"))
	want := "title: demo-project\nlocal: user edit\n\nupstream: new\n"
	if body != want {
		t.Fatalf("README.md = %q, want %q", body, want)
	}
	if strings.Contains(body, "<<<<<<<") {
		t.Fatalf("README.md contains conflict markers:\n%s", body)
	}
}

func TestApplyTemplateUpdateWritesConflictReviewFiles(t *testing.T) {
	oldTemplateRoot := writeUpdateTestTemplate(t, "0.1.0", "title: {{ project.slug }}\nline: base\n")
	newTemplateRoot := writeUpdateTestTemplate(t, "0.2.0", "title: {{ project.slug }}\nline: upstream\n")
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	if _, err := CreateProject(projectRoot, InitOptions{TemplatePath: oldTemplateRoot}); err != nil {
		t.Fatalf("CreateProject returned error: %v", err)
	}
	if _, err := WriteTmpTemplateValues(projectRoot); err != nil {
		t.Fatalf("WriteTmpTemplateValues returned error: %v", err)
	}
	if _, err := InstallDefaultModules(projectRoot); err != nil {
		t.Fatalf("InstallDefaultModules returned error: %v", err)
	}
	mustWriteFile(t, filepath.Join(projectRoot, "README.md"), "title: demo-project\nline: local\n")

	plan, err := PlanTemplateUpdate(projectRoot, TemplateUpdateOptions{TemplatePath: newTemplateRoot})
	if err != nil {
		t.Fatalf("PlanTemplateUpdate returned error: %v", err)
	}
	update := singleUpdateFileChange(t, plan, "README.md")
	if update.Result != "conflict" {
		t.Fatalf("README.md update result = %q, want conflict", update.Result)
	}

	if _, err := ApplyTemplateUpdate(projectRoot, TemplateUpdateOptions{TemplatePath: newTemplateRoot}); err != nil {
		t.Fatalf("ApplyTemplateUpdate returned error: %v", err)
	}
	body := mustReadFile(t, filepath.Join(projectRoot, "README.md"))
	if !strings.Contains(body, "<<<<<<<") || !strings.Contains(body, "line: local") || !strings.Contains(body, "line: upstream") {
		t.Fatalf("README.md does not contain expected conflict content:\n%s", body)
	}
	conflictRoot := filepath.Join(projectRoot, filepath.FromSlash(plan.ConflictFolder), "README.md")
	if got := mustReadFile(t, conflictRoot+".mine"); got != "title: demo-project\nline: local\n" {
		t.Fatalf("mine conflict copy = %q", got)
	}
	if got := mustReadFile(t, conflictRoot+".base"); got != "title: demo-project\nline: base\n" {
		t.Fatalf("base conflict copy = %q", got)
	}
	if got := mustReadFile(t, conflictRoot+".theirs"); got != "title: demo-project\nline: upstream\n" {
		t.Fatalf("theirs conflict copy = %q", got)
	}
}

func TestPlanTemplateUpdateReverseRendersTemplateSelfValues(t *testing.T) {
	templateRoot := writeUpdateSelfValueTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")
	if _, err := CreateProject(projectRoot, InitOptions{TemplatePath: templateRoot}); err != nil {
		t.Fatalf("CreateProject returned error: %v", err)
	}
	if _, err := WriteTmpTemplateValues(projectRoot); err != nil {
		t.Fatalf("WriteTmpTemplateValues returned error: %v", err)
	}
	if _, err := InstallDefaultModules(projectRoot); err != nil {
		t.Fatalf("InstallDefaultModules returned error: %v", err)
	}

	plan, err := PlanTemplateUpdate(projectRoot, TemplateUpdateOptions{TemplatePath: templateRoot})
	if err != nil {
		t.Fatalf("PlanTemplateUpdate returned error: %v", err)
	}
	if len(plan.Files) != 0 {
		t.Fatalf("expected no file changes, got %#v", plan.Files)
	}
}

func writeUpdateTestTemplate(t *testing.T, version string, readmeTemplate string) string {
	t.Helper()
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, ".templateignore"), ".templateignore\ntemplate/**\n")
	mustWriteFile(t, filepath.Join(root, "template", "manifest.yaml"), "name: project-template\nversion: "+version+"\nmodules:\n  - modules/core.yaml\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "core.yaml"), "name: core.fullstack\ndescription: Core test module.\ndefault: true\nvalues:\n  project.slug:\n    type: string\n    required: true\nowns:\n  - README.md\n")
	mustWriteFile(t, filepath.Join(root, "README.md.template"), readmeTemplate)
	return root
}

func writeUpdateSelfValueTemplate(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, ".templateignore"), ".templateignore\ntemplate/**\n")
	mustWriteFile(t, filepath.Join(root, "template", "values.yaml"), "project.slug: project-template\n")
	mustWriteFile(t, filepath.Join(root, "template", "manifest.yaml"), "name: project-template\nversion: 0.1.0\nmodules:\n  - modules/core.yaml\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "core.yaml"), "name: core.fullstack\ndescription: Core test module.\ndefault: true\nvalues:\n  project.slug:\n    type: string\n    required: true\nowns:\n  - README.md\n")
	mustWriteFile(t, filepath.Join(root, "README.md"), "# project-template\n")
	return root
}

func writeSplitModuleUpdateTemplate(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, ".templateignore"), ".templateignore\ntemplate/**\n")
	mustWriteFile(t, filepath.Join(root, "template", "manifest.yaml"), "name: project-template\nversion: 0.2.0\nmodules:\n  - modules/core.yaml\n  - modules/target.yaml\n  - modules/shared.yaml\n  - modules/desktop.yaml\n  - modules/mobile.yaml\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "core.yaml"), "name: core.shared\ndescription: Shared core.\ndefault: true\nmigratesFrom: [core.fullstack]\nvalues:\n  project.slug:\n    type: string\n    required: true\n  app.targets.web:\n    type: boolean\n    required: true\n    default: \"false\"\n  app.devices.web.desktop:\n    type: boolean\n    required: true\n    default: \"false\"\n  app.devices.web.mobile:\n    type: boolean\n    required: true\n    default: \"false\"\n  app.implementations.web.shared:\n    type: boolean\n    required: true\n    default: \"false\"\nowns:\n  - README.md\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "target.yaml"), "name: target.web\ndescription: Web target.\ndependsOn: [core.shared]\nappTarget:\n  id: web\n  devices: [desktop, mobile]\n  sharedModule: implementation.web.shared\n  sharedDevices: [desktop, mobile]\n  deviceModules:\n    desktop: implementation.web.desktop\n    mobile: implementation.web.mobile\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "shared.yaml"), "name: implementation.web.shared\ndescription: Shared web root.\ndependsOn: [target.web]\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "desktop.yaml"), "name: implementation.web.desktop\ndescription: Desktop root.\ndependsOn: [target.web]\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "mobile.yaml"), "name: implementation.web.mobile\ndescription: Mobile root.\ndependsOn: [target.web]\n")
	mustWriteFile(t, filepath.Join(root, "README.md.template"), "title: {{ project.slug }}\n")
	return root
}

func singleUpdateFileChange(t *testing.T, plan TemplateUpdatePlan, path string) TemplateUpdateFileChange {
	t.Helper()
	for _, change := range plan.Files {
		if change.Action == "UPDATE" && change.Path == path {
			return change
		}
	}
	t.Fatalf("missing UPDATE change for %s: %#v", path, plan.Files)
	return TemplateUpdateFileChange{}
}

func mustReadFile(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(body)
}
