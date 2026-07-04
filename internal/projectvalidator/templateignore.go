package projectvalidator

import templatesnapshot "github.com/DotNaos/project-space/internal/snapshot"

type templateIgnore = templatesnapshot.Ignore

func readTemplateIgnore(templateRoot string) templateIgnore {
	return templatesnapshot.ReadTemplateIgnore(templateRoot)
}
