package projectvalidator

type TemplateLock struct {
	Template     string `json:"template"`
	Version      string `json:"version"`
	Commit       string `json:"commit,omitempty"`
	TemplatePath string `json:"templatePath,omitempty"`
}

type TemplateSpec struct {
	Root               string
	Name               string
	Version            string
	StructurePath      string
	StructureSlotsPath string
	Files              map[string]TemplateFileSpec
}

type TemplateFileSpec struct {
	Path         string
	TemplatePath string
	SlotsPath    string
}

type Status string

const (
	StatusOK        Status = "OK"
	StatusAdded     Status = "ADDED"
	StatusMissing   Status = "MISSING"
	StatusChanged   Status = "CHANGED"
	StatusViolation Status = "VIOLATION"
)

type StructureEntry struct {
	Path   string
	Kind   string
	Status Status
	Code   string
	Note   string
	Slot   string
}

type FileDiagnostic struct {
	Path   string
	Status Status
	Note   string
}

type FileValidation struct {
	Path        string
	Status      Status
	Code        string
	Note        string
	Diagnostics []FileDiagnostic
}

type Report struct {
	ProjectRoot   string
	ProjectName   string
	TemplateLabel string
	Structure     []StructureEntry
	Files         []FileValidation
	OK            bool
}
