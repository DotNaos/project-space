package projectvalidator

import (
	templatesnapshot "github.com/DotNaos/project-space/internal/snapshot"
)

func snapshotFiles(templateRoot string) ([]string, error) {
	return templatesnapshot.Files(templateRoot)
}

func includeInTemplateSnapshot(path string, ignore templateIgnore) bool {
	return templatesnapshot.IncludeInSnapshot(path, ignore)
}
