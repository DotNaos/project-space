package main

import "testing"

func TestValidateSmokeProjectFailsForInvalidProject(t *testing.T) {
	root := t.TempDir()

	err := validateSmokeProject(root)
	if err == nil {
		t.Fatal("expected validation error")
	}
}
