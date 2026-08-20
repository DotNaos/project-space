package codextask

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientStartAcceptsCodexStartFailedBlockedReason(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		writeTestJSON(t, response, StartResult{
			APIVersion:  APIVersion,
			Message:     "Codex could not be started on the selected machine.",
			OperationID: testOperationID,
			Reason:      BlockedCodexStartFailed,
			State:       StateBlocked,
		})
	}))
	defer server.Close()

	client := testClient(t, server.URL, Config{})
	result, err := client.Start(context.Background(), StartRequest{
		Selector:     Selector{PhysicalMachineID: "physical-remote"},
		Issue:        299,
		OperationID:  testOperationID,
		RepositoryID: "DotNaos/project-space",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.State != StateBlocked || result.Reason != BlockedCodexStartFailed {
		t.Fatalf("result = %#v", result)
	}
}
