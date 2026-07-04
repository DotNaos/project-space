package projectvalidator

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInitProjectCopiesOnlySnapshotFiles(t *testing.T) {
	templateRoot := writeSnapshotTestTemplate(t)
	projectRoot := filepath.Join(t.TempDir(), "demo-project")

	if _, err := InitProject(projectRoot, InitOptions{TemplatePath: templateRoot}); err != nil {
		t.Fatalf("InitProject returned error: %v", err)
	}

	snapshotRoot := filepath.Join(projectRoot, ".project", "template")
	assertSnapshotFile(t, snapshotRoot, ".templateignore", true)
	assertSnapshotFile(t, snapshotRoot, "template/manifest.yaml", true)
	assertSnapshotFile(t, snapshotRoot, ".slot.yaml", true)
	assertSnapshotFile(t, snapshotRoot, "src/features/.slot.yaml", true)
	assertSnapshotFile(t, snapshotRoot, "README.md.template", true)

	assertSnapshotFile(t, snapshotRoot, "bun.lock", false)
	assertSnapshotFile(t, snapshotRoot, "docs/template.md", false)
	assertSnapshotFile(t, snapshotRoot, "Requirements.md", false)
	assertSnapshotFile(t, snapshotRoot, ".github/workflows/ci.yml", false)
}

func TestChecksumIgnoresTemplateIgnoredFiles(t *testing.T) {
	templateRoot := writeSnapshotTestTemplate(t)

	before, err := checksumTemplateRoot(templateRoot)
	if err != nil {
		t.Fatalf("checksumTemplateRoot returned error: %v", err)
	}
	mustWriteFile(t, filepath.Join(templateRoot, "docs", "template.md"), "changed ignored docs\n")
	afterIgnoredChange, err := checksumTemplateRoot(templateRoot)
	if err != nil {
		t.Fatalf("checksumTemplateRoot returned error after ignored change: %v", err)
	}
	if afterIgnoredChange != before {
		t.Fatalf("checksum changed after ignored file edit: before %s after %s", before, afterIgnoredChange)
	}

	mustWriteFile(t, filepath.Join(templateRoot, "README.md.template"), "# changed {{ project.slug }}\n")
	afterSnapshotChange, err := checksumTemplateRoot(templateRoot)
	if err != nil {
		t.Fatalf("checksumTemplateRoot returned error after snapshot change: %v", err)
	}
	if afterSnapshotChange == before {
		t.Fatal("checksum did not change after snapshot file edit")
	}
}

func TestVerifyTemplateChecksumSkipsLegacyChecksumVersion(t *testing.T) {
	templateRoot := writeSnapshotTestTemplate(t)

	err := verifyTemplateChecksum(templateRoot, TemplateLock{
		Checksum: "sha256:legacy-wide-checksum",
	})
	if err != nil {
		t.Fatalf("verifyTemplateChecksum returned error for legacy checksum: %v", err)
	}
}

func TestValidateProjectAllowsTemplateIgnoredLocalFiles(t *testing.T) {
	templateRoot := writeSnapshotTestTemplate(t)
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
	mustWriteFile(t, filepath.Join(projectRoot, "bun.lock"), "generated lock\n")
	mustWriteFile(t, filepath.Join(projectRoot, ".turbo", "cache", "task.tar.zst"), "cache\n")

	report, err := ValidateProject(projectRoot)
	if err != nil {
		t.Fatalf("ValidateProject returned error: %v", err)
	}
	if !report.OK {
		t.Fatal("template-ignored local files should not make validation fail")
	}
}

func TestInitProjectUnrendersTemplateSelfValuesInSnapshot(t *testing.T) {
	templateRoot := writeSnapshotTestTemplate(t)
	mustWriteFile(t, filepath.Join(templateRoot, "template", "values.yaml"), "project.slug: project-template\nproject.goModule: github.com/DotNaos/project-template\n")
	mustWriteFile(t, filepath.Join(templateRoot, "server", "go.mod"), "module github.com/DotNaos/project-template/server\n")
	mustWriteFile(t, filepath.Join(templateRoot, "template", "modules", "core.yaml"), "name: core.fullstack\ndescription: Core test module.\ndefault: true\nvalues:\n  project.slug:\n    type: string\n    required: true\nowns:\n  - README.md\n  - server/go.mod\n")
	projectRoot := filepath.Join(t.TempDir(), "demo-project")

	if _, err := InitProject(projectRoot, InitOptions{TemplatePath: templateRoot}); err != nil {
		t.Fatalf("InitProject returned error: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(projectRoot, ".project", "template", "server", "go.mod"))
	if err != nil {
		t.Fatalf("read snapshot go.mod: %v", err)
	}
	want := "module {{ project.goModule }}/server\n"
	if string(body) != want {
		t.Fatalf("snapshot go.mod = %q, want %q", string(body), want)
	}
}

func TestChecksumTemplateSourceSnapshotMatchesCopiedSnapshot(t *testing.T) {
	templateRoot := writeSnapshotTestTemplate(t)
	mustWriteFile(t, filepath.Join(templateRoot, "template", "values.yaml"), "project.slug: project-template\n")
	mustWriteFile(t, filepath.Join(templateRoot, "README.md"), "# project-template\n")
	mustWriteFile(t, filepath.Join(templateRoot, "template", "modules", "core.yaml"), "name: core.fullstack\ndescription: Core test module.\ndefault: true\nvalues:\n  project.slug:\n    type: string\n    required: true\nowns:\n  - README.md\n")
	snapshotRoot := filepath.Join(t.TempDir(), "snapshot")
	if err := copySnapshot(templateRoot, snapshotRoot); err != nil {
		t.Fatalf("copySnapshot returned error: %v", err)
	}
	want, err := checksumTemplateRoot(snapshotRoot)
	if err != nil {
		t.Fatalf("checksumTemplateRoot returned error: %v", err)
	}
	got, err := checksumTemplateSourceSnapshot(templateRoot)
	if err != nil {
		t.Fatalf("checksumTemplateSourceSnapshot returned error: %v", err)
	}
	if got != want {
		t.Fatalf("source snapshot checksum = %s, want copied snapshot checksum %s", got, want)
	}
	raw, err := checksumTemplateRoot(templateRoot)
	if err != nil {
		t.Fatalf("raw checksumTemplateRoot returned error: %v", err)
	}
	if raw == got {
		t.Fatal("raw source checksum unexpectedly matched reverse-rendered snapshot checksum")
	}
}

func writeSnapshotTestTemplate(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, ".templateignore"), ".templateignore\ntemplate/**\nbun.lock\ndocs/**\nRequirements.md\n.github/**\n.slot.yaml\n**/.slot.yaml\n.turbo/**\n")
	mustWriteFile(t, filepath.Join(root, "template", "manifest.yaml"), "name: project-template\nversion: 0.1.0\nmodules:\n  - modules/core.yaml\n")
	mustWriteFile(t, filepath.Join(root, "template", "modules", "core.yaml"), "name: core.fullstack\ndescription: Core test module.\ndefault: true\nvalues:\n  project.slug:\n    type: string\n    required: true\nowns:\n  - README.md\n")
	mustWriteFile(t, filepath.Join(root, ".slot.yaml"), "name: root\nallow:\n  - extras/**\n")
	mustWriteFile(t, filepath.Join(root, "src", "features", ".slot.yaml"), "name: features\nallow:\n  - \"{{ feature.slug }}/**\"\npatterns:\n  feature.slug: \"[a-z0-9-]+\"\n")
	mustWriteFile(t, filepath.Join(root, "README.md.template"), "# {{ project.slug }}\n")
	mustWriteFile(t, filepath.Join(root, "bun.lock"), "lock\n")
	mustWriteFile(t, filepath.Join(root, "docs", "template.md"), "docs\n")
	mustWriteFile(t, filepath.Join(root, "Requirements.md"), "requirements\n")
	mustWriteFile(t, filepath.Join(root, ".github", "workflows", "ci.yml"), "name: ci\n")
	return root
}

func assertSnapshotFile(t *testing.T, snapshotRoot string, relative string, want bool) {
	t.Helper()
	_, err := os.Stat(filepath.Join(snapshotRoot, filepath.FromSlash(relative)))
	got := err == nil
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("stat %s returned error: %v", relative, err)
	}
	if got != want {
		t.Fatalf("snapshot file %s present = %t, want %t", relative, got, want)
	}
}
