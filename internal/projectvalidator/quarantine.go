package projectvalidator

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func PlanViolationQuarantine(report Report) ViolationQuarantinePlan {
	quarantineRoot := filepath.Join(report.ProjectRoot, ".project", "quarantine")
	plan := ViolationQuarantinePlan{
		ProjectRoot:    report.ProjectRoot,
		QuarantineRoot: quarantineRoot,
		ManifestPath:   filepath.Join(quarantineRoot, "manifest.tsv"),
	}
	seen := map[string]bool{}
	for _, entry := range report.Structure {
		if entry.Kind != "file" || entry.Status != StatusViolation || entry.Code != "not_allowed" {
			continue
		}
		if seen[entry.Path] {
			continue
		}
		seen[entry.Path] = true
		quarantinePath := filepath.ToSlash(filepath.Join(".project", "quarantine", filepath.FromSlash(entry.Path)))
		plan.Files = append(plan.Files, ViolationQuarantineFile{
			Action:         "MOVE",
			OriginalPath:   entry.Path,
			QuarantinePath: quarantinePath,
			Code:           entry.Code,
			Module:         entry.Module,
		})
	}
	plan.WouldWrite = len(plan.Files) > 0
	return plan
}

func ApplyViolationQuarantine(plan ViolationQuarantinePlan) (ViolationQuarantinePlan, error) {
	if len(plan.Files) == 0 {
		return plan, nil
	}
	for _, file := range plan.Files {
		sourcePath := filepath.Join(plan.ProjectRoot, filepath.FromSlash(file.OriginalPath))
		targetPath := filepath.Join(plan.ProjectRoot, filepath.FromSlash(file.QuarantinePath))
		if _, err := os.Stat(sourcePath); err != nil {
			return plan, fmt.Errorf("quarantine source %s: %w", file.OriginalPath, err)
		}
		if _, err := os.Stat(targetPath); err == nil {
			return plan, fmt.Errorf("quarantine target already exists: %s", file.QuarantinePath)
		} else if !os.IsNotExist(err) {
			return plan, err
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return plan, err
		}
		if err := os.Rename(sourcePath, targetPath); err != nil {
			return plan, fmt.Errorf("move %s to quarantine: %w", file.OriginalPath, err)
		}
		removeEmptyParents(plan.ProjectRoot, filepath.Dir(sourcePath))
	}
	if err := writeViolationQuarantineManifest(plan); err != nil {
		return plan, err
	}
	return plan, nil
}

func writeViolationQuarantineManifest(plan ViolationQuarantinePlan) error {
	if err := os.MkdirAll(filepath.Dir(plan.ManifestPath), 0o755); err != nil {
		return err
	}
	lines := []string{"action\toriginal_path\tquarantine_path\tcode\tmodule"}
	for _, file := range plan.Files {
		module := file.Module
		if module == "" {
			module = "-"
		}
		lines = append(lines, strings.Join([]string{file.Action, file.OriginalPath, file.QuarantinePath, file.Code, module}, "\t"))
	}
	return os.WriteFile(plan.ManifestPath, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
}
