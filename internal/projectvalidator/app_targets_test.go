package projectvalidator

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

func TestCreateProjectEmitsOnlySelectedAppTargetsAndDevices(t *testing.T) {
	templateRoot := writeAppTargetTemplate(t)
	lint, err := LintTemplate(templateRoot)
	if err != nil {
		t.Fatalf("LintTemplate returned error: %v", err)
	}
	if !lint.OK {
		t.Fatalf("template lint failed: %#v", lint.Findings)
	}
	projectRoot := filepath.Join(t.TempDir(), "demo-app")
	_, err = CreateProject(projectRoot, InitOptions{
		TemplatePath: templateRoot,
		Targets: []AppTargetSelection{
			{Target: "web", Devices: []string{"desktop", "mobile"}},
		},
	})
	if err != nil {
		t.Fatalf("CreateProject returned error: %v", err)
	}

	lock, err := readTemplateLock(projectRoot)
	if err != nil {
		t.Fatalf("readTemplateLock returned error: %v", err)
	}
	if want := []string{"core", "implementation.web.shared", "target.web"}; !reflect.DeepEqual(lock.Modules, want) {
		t.Fatalf("modules = %v, want %v", lock.Modules, want)
	}
	assertFileExists(t, filepath.Join(projectRoot, "clients", "web", "src", "main.tsx"))
	assertFileExists(t, filepath.Join(projectRoot, "clients", "web", "src", "app-roots", "app.tsx"))
	assertFileMissing(t, filepath.Join(projectRoot, "clients", "web", "src", "app-roots", "App.desktop.tsx"))
	assertFileMissing(t, filepath.Join(projectRoot, "clients", "native", "index.ts"))

	body, err := os.ReadFile(filepath.Join(projectRoot, "app.manifest.json"))
	if err != nil {
		t.Fatalf("read app.manifest.json: %v", err)
	}
	var manifest struct {
		Targets map[string]struct {
			Devices map[string]any `json:"devices"`
		} `json:"targets"`
	}
	if err := json.Unmarshal(body, &manifest); err != nil {
		t.Fatalf("parse app.manifest.json: %v\n%s", err, body)
	}
	if len(manifest.Targets) != 1 {
		t.Fatalf("targets = %#v", manifest.Targets)
	}
	if want := []string{"desktop", "mobile"}; !reflect.DeepEqual(sortedKeys(manifest.Targets["web"].Devices), want) {
		t.Fatalf("web devices = %v, want %v", sortedKeys(manifest.Targets["web"].Devices), want)
	}

	report, err := ValidateProject(projectRoot)
	if err != nil {
		t.Fatalf("ValidateProject returned error: %v", err)
	}
	if !report.OK {
		t.Fatalf("generated project did not validate: %#v", report.Files)
	}
}

func TestCreateProjectRequiresExplicitSelectionForAppTemplate(t *testing.T) {
	_, err := CreateProject(filepath.Join(t.TempDir(), "demo-app"), InitOptions{TemplatePath: writeAppTargetTemplate(t)})
	if err == nil {
		t.Fatal("expected target selection error")
	}
}

func TestCreateProjectCanEmitNativeWithoutWeb(t *testing.T) {
	projectRoot := filepath.Join(t.TempDir(), "native-app")
	_, err := CreateProject(projectRoot, InitOptions{
		TemplatePath: writeAppTargetTemplate(t),
		Targets:      []AppTargetSelection{{Target: "native", Devices: []string{"mobile"}}},
	})
	if err != nil {
		t.Fatalf("CreateProject returned error: %v", err)
	}
	assertFileExists(t, filepath.Join(projectRoot, "clients", "native", "index.ts"))
	assertFileExists(t, filepath.Join(projectRoot, "clients", "native", "src", "app-roots", "App.mobile.tsx"))
	assertFileMissing(t, filepath.Join(projectRoot, "clients", "web", "src", "main.tsx"))
	body, err := os.ReadFile(filepath.Join(projectRoot, "app.manifest.json"))
	if err != nil {
		t.Fatalf("read app.manifest.json: %v", err)
	}
	var manifest struct {
		Targets map[string]any `json:"targets"`
	}
	if err := json.Unmarshal(body, &manifest); err != nil {
		t.Fatalf("parse app.manifest.json: %v\n%s", err, body)
	}
	if want := []string{"native"}; !reflect.DeepEqual(sortedKeys(manifest.Targets), want) {
		t.Fatalf("targets = %v, want %v", sortedKeys(manifest.Targets), want)
	}
	mustWriteFile(t, filepath.Join(projectRoot, "clients", "web", "src", "routes", "unexpected", "index.ts"), "export {};\n")
	report, err := ValidateProject(projectRoot)
	if err != nil {
		t.Fatalf("ValidateProject returned error: %v", err)
	}
	if report.OK {
		t.Fatal("an unselected web route was accepted through the inactive web slot")
	}
}

func TestCreateProjectCanEmitDistinctImplementationsForMultipleDevices(t *testing.T) {
	templateRoot := writeAppTargetTemplate(t)
	mustWriteFile(t, filepath.Join(templateRoot, "template", "modules", "web.yaml"), `name: target.web
description: Web target.
dependsOn: [core]
appTarget:
  id: web
  devices: [desktop, tablet, mobile]
  deviceModules:
    desktop: implementation.web.desktop
    tablet: implementation.web.tablet
    mobile: implementation.web.mobile
owns:
  - clients/web/src/main.tsx
  - clients/web/src/routes/**/*
`)
	projectRoot := filepath.Join(t.TempDir(), "distinct-web")
	_, err := CreateProject(projectRoot, InitOptions{
		TemplatePath: templateRoot,
		Targets:      []AppTargetSelection{{Target: "web", Devices: []string{"desktop", "mobile"}}},
	})
	if err != nil {
		t.Fatalf("CreateProject returned error: %v", err)
	}
	assertFileExists(t, filepath.Join(projectRoot, "clients", "web", "src", "app-roots", "App.desktop.tsx"))
	assertFileExists(t, filepath.Join(projectRoot, "clients", "web", "src", "app-roots", "App.mobile.tsx"))
	assertFileMissing(t, filepath.Join(projectRoot, "clients", "web", "src", "app-roots", "app.tsx"))
}

func TestCreateProjectRejectsUnsupportedAppDevice(t *testing.T) {
	_, err := CreateProject(filepath.Join(t.TempDir(), "demo-app"), InitOptions{
		TemplatePath: writeAppTargetTemplate(t),
		Targets:      []AppTargetSelection{{Target: "native", Devices: []string{"desktop"}}},
	})
	if err == nil {
		t.Fatal("expected unsupported device error")
	}
}

func TestTemplateUpdatePreservesAppTargetSelection(t *testing.T) {
	currentTemplate := writeAppTargetTemplate(t)
	nextTemplate := writeAppTargetTemplate(t)
	mustWriteFile(t, filepath.Join(nextTemplate, "clients", "web", "src", "main.tsx"), "export const updated = true;\n")
	projectRoot := filepath.Join(t.TempDir(), "demo-app")
	_, err := CreateProject(projectRoot, InitOptions{
		TemplatePath: currentTemplate,
		Targets:      []AppTargetSelection{{Target: "web", Devices: []string{"mobile"}}},
	})
	if err != nil {
		t.Fatalf("CreateProject returned error: %v", err)
	}

	if _, err := ApplyTemplateUpdate(projectRoot, TemplateUpdateOptions{TemplatePath: nextTemplate}); err != nil {
		t.Fatalf("ApplyTemplateUpdate returned error: %v", err)
	}
	values, err := readTemplateValues(projectRoot)
	if err != nil {
		t.Fatalf("readTemplateValues returned error: %v", err)
	}
	if selected, err := lookupTemplateBool(values, "app.devices.web.mobile"); err != nil || !selected {
		t.Fatalf("web mobile selection = %v, %v", selected, err)
	}
	if selected, err := lookupTemplateBool(values, "app.devices.web.desktop"); err != nil || selected {
		t.Fatalf("web desktop selection = %v, %v", selected, err)
	}
	assertFileExists(t, filepath.Join(projectRoot, "clients", "web", "src", "main.tsx"))
	assertFileMissing(t, filepath.Join(projectRoot, "clients", "native", "index.ts"))
}

func TestConditionalTemplateRejectsMissingBoolean(t *testing.T) {
	_, err := renderTemplateBody([]byte("{{#if app.targets.web}}\nweb\n{{/if}}\n"), TemplateValues{})
	if err == nil {
		t.Fatal("expected missing condition value error")
	}
}

func TestConditionalTemplateRejectsMalformedDirective(t *testing.T) {
	_, err := renderTemplateBody([]byte("{{#if app.targets.web trailing}}\nweb\n{{/if}}\n"), TemplateValues{})
	if err == nil {
		t.Fatal("expected invalid conditional syntax error")
	}
}

func TestAppTargetRequiresImplementationModulesForEverySelection(t *testing.T) {
	template := TemplateSpec{Modules: map[string]TemplateModuleSpec{
		"target.web": {
			Name: "target.web",
			AppTarget: &TemplateAppTargetSpec{
				ID:      "web",
				Devices: []string{"desktop", "mobile"},
			},
		},
	}}
	if err := validateTemplateAppTargets(template); err == nil {
		t.Fatal("expected missing implementation module error")
	}
}

func TestValidateProjectSupportsLegacyLockWithoutModules(t *testing.T) {
	templateRoot := writeTestTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "legacy-project")
	if _, err := CreateProject(projectRoot, InitOptions{TemplatePath: templateRoot}); err != nil {
		t.Fatalf("CreateProject returned error: %v", err)
	}
	if _, err := WriteTmpTemplateValues(projectRoot); err != nil {
		t.Fatalf("WriteTmpTemplateValues returned error: %v", err)
	}
	if _, err := InstallDefaultModules(projectRoot); err != nil {
		t.Fatalf("InstallDefaultModules returned error: %v", err)
	}
	lock, err := readTemplateLock(projectRoot)
	if err != nil {
		t.Fatalf("readTemplateLock returned error: %v", err)
	}
	lock.Modules = nil
	if _, err := writeTemplateLock(projectRoot, lock); err != nil {
		t.Fatalf("writeTemplateLock returned error: %v", err)
	}
	report, err := ValidateProject(projectRoot)
	if err != nil {
		t.Fatalf("ValidateProject returned error: %v", err)
	}
	if !report.OK {
		t.Fatalf("legacy project did not validate: %#v", report.Files)
	}
}

func writeAppTargetTemplate(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, ".templateignore"), ".templateignore\ntemplate/**\nschema/template-*.schema.json\n**/.slot.yaml\n")
	mustWriteFile(t, filepath.Join(root, "schema", "template-manifest.schema.json"), "{}\n")
	mustWriteFile(t, filepath.Join(root, "schema", "template-module.schema.json"), "{}\n")
	mustWriteFile(t, filepath.Join(root, "template", "manifest.yaml"), "name: app-template\nversion: 1.0.0\nmodules:\n  - modules/core.yaml\n  - modules/web.yaml\n  - modules/web-shared.yaml\n  - modules/web-desktop.yaml\n  - modules/web-tablet.yaml\n  - modules/web-mobile.yaml\n  - modules/native.yaml\n  - modules/native-mobile.yaml\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "core.yaml"), `name: core
description: Shared app files.
default: true
values:
  project.slug:
    type: string
    required: true
  app.targets.web:
    type: boolean
    required: true
    default: "false"
  app.targets.native:
    type: boolean
    required: true
    default: "false"
  app.devices.web.desktop:
    type: boolean
    required: true
    default: "false"
  app.devices.web.tablet:
    type: boolean
    required: true
    default: "false"
  app.devices.web.mobile:
    type: boolean
    required: true
    default: "false"
  app.devices.native.mobile:
    type: boolean
    required: true
    default: "false"
owns:
  - app.manifest.json
`)
	mustWriteFile(t, filepath.Join(root, "template", "modules", "web.yaml"), `name: target.web
description: Web target.
dependsOn: [core]
appTarget:
  id: web
  devices: [desktop, tablet, mobile]
  sharedModule: implementation.web.shared
  sharedDevices: [desktop, tablet, mobile]
  deviceModules:
    desktop: implementation.web.desktop
    tablet: implementation.web.tablet
    mobile: implementation.web.mobile
owns:
  - clients/web/src/main.tsx
  - clients/web/src/routes/**/*
`)
	mustWriteFile(t, filepath.Join(root, "template", "modules", "web-shared.yaml"), "name: implementation.web.shared\ndescription: Shared web root.\ndependsOn: [target.web]\nowns:\n  - clients/web/src/app-roots/app.tsx\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "web-desktop.yaml"), "name: implementation.web.desktop\ndescription: Desktop web root.\ndependsOn: [target.web]\nowns:\n  - clients/web/src/app-roots/App.desktop.tsx\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "web-tablet.yaml"), "name: implementation.web.tablet\ndescription: Tablet web root.\ndependsOn: [target.web]\nowns:\n  - clients/web/src/app-roots/App.tablet.tsx\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "web-mobile.yaml"), "name: implementation.web.mobile\ndescription: Mobile web root.\ndependsOn: [target.web]\nowns:\n  - clients/web/src/app-roots/App.mobile.tsx\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "native.yaml"), `name: target.native
description: Native target.
dependsOn: [core]
appTarget:
  id: native
  devices: [mobile]
  deviceModules:
    mobile: implementation.native.mobile
owns:
  - clients/native/index.ts
`)
	mustWriteFile(t, filepath.Join(root, "template", "modules", "native-mobile.yaml"), "name: implementation.native.mobile\ndescription: Native mobile root.\ndependsOn: [target.native]\nowns:\n  - clients/native/src/app-roots/App.mobile.tsx\n")
	mustWriteFile(t, filepath.Join(root, "app.manifest.json.template"), `{
  "targets": {
{{#if app.targets.web}}
    "web": { "devices": {
{{#if app.devices.web.desktop}}
      "desktop": {}
{{#if app.devices.web.tablet}}
      ,
{{/if}}
{{#if app.devices.web.mobile}}
      ,
{{/if}}
{{/if}}
{{#if app.devices.web.tablet}}
      "tablet": {}
{{#if app.devices.web.mobile}}
      ,
{{/if}}
{{/if}}
{{#if app.devices.web.mobile}}
      "mobile": {}
{{/if}}
    } }
{{#if app.targets.native}}
    ,
{{/if}}
{{/if}}
{{#if app.targets.native}}
    "native": { "devices": { "mobile": {} } }
{{/if}}
  }
}
`)
	mustWriteFile(t, filepath.Join(root, "clients", "web", "src", "main.tsx"), "export {};\n")
	mustWriteFile(t, filepath.Join(root, "clients", "web", "src", "routes", ".slot.yaml"), "name: web.routes\nallow:\n  - '{route}/**/*'\npatterns:\n  route: '[a-z][a-z0-9-]*'\n")
	mustWriteFile(t, filepath.Join(root, "clients", "web", "src", "app-roots", "app.tsx"), "export {};\n")
	mustWriteFile(t, filepath.Join(root, "clients", "web", "src", "app-roots", "App.desktop.tsx"), "export {};\n")
	mustWriteFile(t, filepath.Join(root, "clients", "web", "src", "app-roots", "App.tablet.tsx"), "export {};\n")
	mustWriteFile(t, filepath.Join(root, "clients", "web", "src", "app-roots", "App.mobile.tsx"), "export {};\n")
	mustWriteFile(t, filepath.Join(root, "clients", "native", "index.ts"), "export {};\n")
	mustWriteFile(t, filepath.Join(root, "clients", "native", "src", "app-roots", "App.mobile.tsx"), "export {};\n")
	return root
}

func assertFileExists(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected file %s: %v", path, err)
	}
}

func assertFileMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected file %s to be absent, got %v", path, err)
	}
}

func sortedKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
