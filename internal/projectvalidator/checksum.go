package projectvalidator

import (
	"fmt"
	"os"

	templatesnapshot "github.com/DotNaos/project-space/internal/snapshot"
)

const templateChecksumVersion = 2

func checksumTemplateRoot(templateRoot string) (string, error) {
	return templatesnapshot.Checksum(templateRoot)
}

func checksumTemplateSourceSnapshot(sourceRoot string) (string, error) {
	tempRoot, err := os.MkdirTemp("", "project-template-checksum-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tempRoot)
	if err := copySnapshot(sourceRoot, tempRoot); err != nil {
		return "", err
	}
	return checksumTemplateRoot(tempRoot)
}

func verifyTemplateChecksum(templateRoot string, lock TemplateLock) error {
	if lock.Checksum == "" {
		return nil
	}
	if lock.ChecksumVersion == 0 {
		return nil
	}
	if lock.ChecksumVersion != templateChecksumVersion {
		return fmt.Errorf("unsupported template checksum version %d; run project template sync to refresh it", lock.ChecksumVersion)
	}
	actual, err := checksumTemplateRoot(templateRoot)
	if err != nil {
		return err
	}
	if actual != lock.Checksum {
		return fmt.Errorf("template checksum mismatch: lock has %s, local template has %s", lock.Checksum, actual)
	}
	return nil
}
