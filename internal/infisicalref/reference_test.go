package infisicalref

import "testing"

func TestParse(t *testing.T) {
	reference, err := Parse(
		"infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/GITHUB_OAUTH_CLIENT_ID",
		"GITHUB_OAUTH_CLIENT_ID",
	)
	if err != nil {
		t.Fatal(err)
	}
	if reference.ProjectID != "d786940c-96a1-4937-981a-dc8729effcf4" ||
		reference.Environment != "dev" || reference.SecretName != "GITHUB_OAUTH_CLIENT_ID" {
		t.Fatalf("reference = %+v", reference)
	}
}

func TestParseRejectsMismatchedOrMalformedReferences(t *testing.T) {
	for _, source := range []string{
		"op://projects/item/password",
		"infisical://not-a-project/dev/TOKEN",
		"infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/OTHER",
		"infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/TOKEN/extra",
	} {
		if _, err := Parse(source, "TOKEN"); err == nil {
			t.Fatalf("Parse(%q) succeeded", source)
		}
	}
}
