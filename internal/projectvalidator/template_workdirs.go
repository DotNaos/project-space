package projectvalidator

func shouldSkipTemplateWorkDir(name string) bool {
	switch name {
	case ".git", "node_modules", ".turbo", "tmp", "temp", "dist", "bin":
		return true
	default:
		return false
	}
}
