package main

import (
	"reflect"
	"testing"

	"github.com/DotNaos/project-space/internal/projectvalidator"
)

func TestParseAppTargetSelections(t *testing.T) {
	got, err := parseAppTargetSelections([]string{"web:desktop,mobile", "native:mobile"})
	if err != nil {
		t.Fatalf("parseAppTargetSelections returned error: %v", err)
	}
	want := []projectvalidator.AppTargetSelection{
		{Target: "web", Devices: []string{"desktop", "mobile"}},
		{Target: "native", Devices: []string{"mobile"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("selections = %#v, want %#v", got, want)
	}
}

func TestParseAppTargetSelectionsRejectsMissingDevices(t *testing.T) {
	if _, err := parseAppTargetSelections([]string{"web"}); err == nil {
		t.Fatal("expected invalid target selection error")
	}
}
