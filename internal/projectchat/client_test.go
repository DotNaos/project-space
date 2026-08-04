package projectchat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testThreadID  = "019f49e1-cc3d-7243-bc12-75c74c786457"
	testToken     = "machine-secret-token"
	testMachineID = "machine-1"
)

func TestClientListsAndClaimsRegistryNamesWithTrustedHeaders(t *testing.T) {
	parentThreadID := "019f49e1-cc3d-7243-bc12-75c74c786458"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get(threadIDHeader) != testThreadID || request.Header.Get(machineIDHeader) != testMachineID {
			t.Fatalf("missing trusted identity headers")
		}
		switch request.Method + " " + request.URL.Path {
		case "GET " + namesPath:
			writeJSON(t, writer, http.StatusOK, NameCatalog{Groups: []NameGroup{{Category: NameCategoryScience, Names: []NameEntry{{Name: "Turing", Category: NameCategoryScience, State: "available"}}}}})
		case "POST " + nameClaimsPath:
			body := nameClaimRequest{}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Name != "Turing" || body.Category != NameCategoryScience || body.ParentThreadID != parentThreadID {
				t.Fatalf("claim body = %#v", body)
			}
			writeJSON(t, writer, http.StatusCreated, nameClaimResponse{Claim: NameClaim{Name: "Turing", DisplayName: "Athena.Turing", Category: NameCategoryScience, ThreadID: testThreadID, ParentThreadID: parentThreadID}})
		case "POST " + automaticNameClaimsPath:
			body := automaticNameClaimRequest{}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if strings.Join(body.ExcludedNames, ",") != "Aebaden,Albaden" || body.PreferredName != "Arbaden" {
				t.Fatalf("automatic claim body = %#v", body)
			}
			writeJSON(t, writer, http.StatusCreated, nameClaimResponse{Claim: NameClaim{Name: "Arbaden", DisplayName: "Arbaden", Category: NameCategoryMythology, ThreadID: testThreadID}})
		default:
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
	}))
	t.Cleanup(server.Close)
	client := newTestClient(t, server)
	catalog, err := client.ListNames(context.Background(), testThreadID)
	if err != nil || catalog.Groups[0].Names[0].Name != "Turing" {
		t.Fatalf("ListNames() = %#v, %v", catalog, err)
	}
	claim, err := client.ClaimName(context.Background(), testThreadID, "Turing", NameCategoryScience, parentThreadID)
	if err != nil || claim.ParentThreadID != parentThreadID {
		t.Fatalf("ClaimName() = %#v, %v", claim, err)
	}
	automaticClaim, err := client.ClaimAutomaticName(
		context.Background(), testThreadID, []string{"Aebaden", "Albaden"}, "Arbaden",
	)
	if err != nil || automaticClaim.Name != "Arbaden" {
		t.Fatalf("ClaimAutomaticName() = %#v, %v", automaticClaim, err)
	}
}

func TestClientSendUsesVerifiedHeadersAndIdempotencyKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != messagesPath {
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer "+testToken {
			t.Fatalf("Authorization = %q", got)
		}
		if got := request.Header.Get(threadIDHeader); got != testThreadID {
			t.Fatalf("thread header = %q", got)
		}
		if got := request.Header.Get(machineIDHeader); got != testMachineID {
			t.Fatalf("machine header = %q", got)
		}
		if got := request.Header.Get(idempotencyKeyHeader); got != "chat-request-1" {
			t.Fatalf("idempotency header = %q", got)
		}
		if strings.Contains(request.URL.RawQuery, testToken) {
			t.Fatal("credential leaked into query")
		}
		rawBody, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read send request: %v", err)
		}
		for _, forbidden := range []string{testToken, testThreadID, `"role"`, `"identity"`} {
			if strings.Contains(string(rawBody), forbidden) {
				t.Fatalf("send JSON contains forbidden identity material %q", forbidden)
			}
		}
		body := sendRequest{}
		if err := json.Unmarshal(rawBody, &body); err != nil {
			t.Fatalf("decode send request: %v", err)
		}
		if body.ChannelID != GeneralChannel || body.Body != "hello" || body.IdempotencyKey != "chat-request-1" {
			t.Fatalf("unexpected send request: %#v", body)
		}
		writeJSON(t, writer, http.StatusCreated, sendResponse{Message: testMessage(1, "hello")})
	}))
	t.Cleanup(server.Close)

	client := newTestClient(t, server)
	message, err := client.Send(context.Background(), testThreadID, GeneralChannel, "hello", "chat-request-1")
	if err != nil {
		t.Fatalf("Send() error: %v", err)
	}
	if message.Sequence != 1 || message.Body != "hello" {
		t.Fatalf("unexpected message: %#v", message)
	}
}

func TestClientJoinsAndRefreshesAgentPresenceWithoutClaimingRole(t *testing.T) {
	profile := AgentProfile{DisplayName: "Mira", TaskTitle: "Project Chat"}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get(threadIDHeader) != testThreadID {
			t.Fatalf("thread header = %q", request.Header.Get(threadIDHeader))
		}
		rawBody, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read request: %v", err)
		}
		for _, forbidden := range []string{testThreadID, `"role"`, `"accountId"`, `"machineId"`, `"hostId"`} {
			if strings.Contains(string(rawBody), forbidden) {
				t.Fatalf("lifecycle JSON contains authority field %q: %s", forbidden, rawBody)
			}
		}
		sender := testMessage(1, "ignored").Sender
		switch request.URL.Path {
		case joinPath:
			calls.Add(1)
			value := joinRequest{}
			if json.Unmarshal(rawBody, &value) != nil || value.DisplayName != profile.DisplayName ||
				value.TaskTitle != profile.TaskTitle {
				t.Fatalf("unexpected join request: %#v", value)
			}
			response := joinResponse{Member: sender}
			response.Channel.ChannelID = GeneralChannel
			writeJSON(t, writer, http.StatusOK, response)
		case presencePath:
			calls.Add(1)
			value := presenceRequest{}
			if json.Unmarshal(rawBody, &value) != nil || value.State != "working" ||
				value.TaskTitle == nil || *value.TaskTitle != profile.TaskTitle {
				t.Fatalf("unexpected presence request: %#v", value)
			}
			writeJSON(t, writer, http.StatusOK, sender)
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
	}))
	t.Cleanup(server.Close)

	client := newTestClient(t, server)
	if err := client.Join(context.Background(), testThreadID, profile); err != nil {
		t.Fatalf("Join() error: %v", err)
	}
	if err := client.UpdatePresence(context.Background(), testThreadID, profile); err != nil {
		t.Fatalf("UpdatePresence() error: %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("lifecycle calls = %d, want 2", calls.Load())
	}
}

func TestClientPresenceExplicitlyClearsMissingTaskTitle(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		rawBody, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read request: %v", err)
		}
		if !strings.Contains(string(rawBody), `"taskTitle":null`) {
			t.Fatalf("presence request did not explicitly clear task title: %s", rawBody)
		}
		writeJSON(t, writer, http.StatusOK, testMessage(1, "ignored").Sender)
	}))
	t.Cleanup(server.Close)

	client := newTestClient(t, server)
	if err := client.UpdatePresence(context.Background(), testThreadID, AgentProfile{DisplayName: "Mira"}); err != nil {
		t.Fatalf("UpdatePresence() error: %v", err)
	}
}

func TestClientRejectsAgentMessageWithoutVerifiedOrigin(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		message := testMessage(1, "update")
		message.Sender.Origin = nil
		writeJSON(t, writer, http.StatusOK, ReadResult{
			ChannelID: GeneralChannel, Messages: []Message{message}, NextSequence: 1, LatestSequence: 1,
		})
	}))
	t.Cleanup(server.Close)

	client := newTestClient(t, server)
	_, err := client.Read(context.Background(), testThreadID, GeneralChannel, DefaultReadLimit)
	if !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("Read() error = %v, want invalid response", err)
	}
}

func TestClientReadAndAcknowledgeContract(t *testing.T) {
	var readCalled atomic.Bool
	var acknowledgeCalled atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodGet && request.URL.Path == messagesPath:
			readCalled.Store(true)
			if got := request.URL.Query(); got.Get("channelId") != GeneralChannel || got.Get("limit") != "100" {
				t.Fatalf("unexpected read query: %s", got.Encode())
			}
			if request.URL.Query().Has("afterSequence") {
				t.Fatal("initial unread request must use the persisted server cursor")
			}
			writeJSON(t, writer, http.StatusOK, ReadResult{
				ChannelID:      GeneralChannel,
				Messages:       []Message{testMessage(4, "update")},
				AfterSequence:  3,
				NextSequence:   4,
				LatestSequence: 4,
			})
		case request.Method == http.MethodPost && request.URL.Path == acknowledgementPath:
			acknowledgeCalled.Store(true)
			acknowledgement := acknowledgementRequest{}
			if err := json.NewDecoder(request.Body).Decode(&acknowledgement); err != nil {
				t.Fatalf("decode acknowledgement: %v", err)
			}
			if acknowledgement.ChannelID != GeneralChannel || acknowledgement.ThroughSequence != 4 {
				t.Fatalf("unexpected acknowledgement: %#v", acknowledgement)
			}
			writeJSON(t, writer, http.StatusOK, acknowledgementResponse{
				ChannelID: GeneralChannel,
				Sequence:  4,
				UpdatedAt: time.Now().UTC(),
			})
		default:
			t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		}
	}))
	t.Cleanup(server.Close)

	client := newTestClient(t, server)
	result, err := client.Read(context.Background(), testThreadID, GeneralChannel, DefaultReadLimit)
	if err != nil {
		t.Fatalf("Read() error: %v", err)
	}
	if err := client.Acknowledge(context.Background(), testThreadID, GeneralChannel, result.NextSequence); err != nil {
		t.Fatalf("Acknowledge() error: %v", err)
	}
	if !readCalled.Load() || !acknowledgeCalled.Load() {
		t.Fatalf("read=%v acknowledge=%v", readCalled.Load(), acknowledgeCalled.Load())
	}
}

func TestClientRejectsRedirects(t *testing.T) {
	var targetCalled atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		targetCalled.Store(true)
	}))
	t.Cleanup(target.Close)
	redirect := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, target.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirect.Close)

	client := newTestClient(t, redirect)
	_, err := client.Read(context.Background(), testThreadID, GeneralChannel, DefaultReadLimit)
	if !errors.Is(err, ErrRedirectRejected) {
		t.Fatalf("Read() error = %v, want redirect rejection", err)
	}
	if targetCalled.Load() {
		t.Fatal("redirect target received the authenticated request")
	}
}

func TestClientPreservesCallerCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(t, writer, http.StatusOK, NameCatalog{})
	}))
	t.Cleanup(server.Close)

	client := newTestClient(t, server)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := client.ListNames(ctx, testThreadID)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("ListNames() error = %v, want context cancellation", err)
	}
}

func TestClientEnforcesRequestAndResponseLimits(t *testing.T) {
	t.Run("message", func(t *testing.T) {
		var called atomic.Bool
		server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			called.Store(true)
		}))
		t.Cleanup(server.Close)
		client := newTestClient(t, server)
		_, err := client.Send(
			context.Background(),
			testThreadID,
			GeneralChannel,
			strings.Repeat("a", MaxMessageCharacters+1),
			"chat-request-1",
		)
		if !errors.Is(err, ErrMessageTooLarge) {
			t.Fatalf("Send() error = %v, want message limit", err)
		}
		if called.Load() {
			t.Fatal("oversized message reached the server")
		}
	})

	t.Run("response", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(strings.Repeat("x", int(MaxResponseBytes)+1)))
		}))
		t.Cleanup(server.Close)
		client := newTestClient(t, server)
		_, err := client.Read(context.Background(), testThreadID, GeneralChannel, DefaultReadLimit)
		if !errors.Is(err, ErrResponseTooLarge) {
			t.Fatalf("Read() error = %v, want response limit", err)
		}
	})
}

func TestClientMapsErrorsWithoutLeakingServerContent(t *testing.T) {
	tests := []struct {
		name   string
		status int
		code   string
		want   error
	}{
		{name: "not registered", status: http.StatusForbidden, code: "not_member", want: ErrNotRegistered},
		{name: "content rejected", status: http.StatusUnprocessableEntity, code: "content_rejected", want: ErrContentRejected},
		{name: "unauthorized", status: http.StatusUnauthorized, code: "", want: ErrUnauthorized},
		{name: "rate limited", status: http.StatusTooManyRequests, code: "rate_limited", want: ErrRateLimited},
		{name: "unavailable", status: http.StatusServiceUnavailable, code: "", want: ErrUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if strings.Contains(request.URL.RawQuery, testToken) {
					t.Fatal("credential leaked into URL")
				}
				writeJSON(t, writer, test.status, map[string]any{
					"error": map[string]any{
						"code":    test.code,
						"message": "server echoed " + testToken,
					},
				})
			}))
			t.Cleanup(server.Close)
			client := newTestClient(t, server)
			_, err := client.Read(context.Background(), testThreadID, GeneralChannel, DefaultReadLimit)
			if !errors.Is(err, test.want) {
				t.Fatalf("Read() error = %v, want %v", err, test.want)
			}
			if strings.Contains(fmt.Sprint(err), testToken) {
				t.Fatal("credential leaked into returned error")
			}
		})
	}
}

func TestClientDoesNotLeakCredentialProviderOrTransportErrors(t *testing.T) {
	t.Run("provider", func(t *testing.T) {
		client, err := NewClient(Config{
			BaseURL:   "https://example.com",
			MachineID: testMachineID,
			CredentialProvider: CredentialProviderFunc(func(context.Context) (string, error) {
				return "", errors.New("could not load " + testToken)
			}),
		})
		if err != nil {
			t.Fatalf("NewClient() error: %v", err)
		}
		_, err = client.Read(context.Background(), testThreadID, GeneralChannel, DefaultReadLimit)
		if !errors.Is(err, ErrMissingCredential) || strings.Contains(fmt.Sprint(err), testToken) {
			t.Fatalf("Read() error = %v", err)
		}
	})

	t.Run("transport", func(t *testing.T) {
		client, err := NewClient(Config{
			BaseURL:   "http://127.0.0.1:5177",
			MachineID: testMachineID,
			HTTPClient: &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
				return nil, errors.New("transport exposed " + testToken)
			})},
			CredentialProvider: CredentialProviderFunc(func(context.Context) (string, error) {
				return testToken, nil
			}),
		})
		if err != nil {
			t.Fatalf("NewClient() error: %v", err)
		}
		_, err = client.Read(context.Background(), testThreadID, GeneralChannel, DefaultReadLimit)
		if !errors.Is(err, ErrUnavailable) || strings.Contains(fmt.Sprint(err), testToken) {
			t.Fatalf("Read() error = %v", err)
		}
	})
}

func TestClientRejectsUnsafeBaseURLsAndSetsTimeout(t *testing.T) {
	credential := CredentialProviderFunc(func(context.Context) (string, error) { return testToken, nil })
	for _, rawURL := range []string{
		"http://example.com",
		"ftp://127.0.0.1",
		"https://token@example.com",
		"https://example.com?access_token=secret",
	} {
		t.Run(rawURL, func(t *testing.T) {
			_, err := NewClient(Config{BaseURL: rawURL, CredentialProvider: credential, MachineID: testMachineID})
			if !errors.Is(err, ErrInvalidBaseURL) {
				t.Fatalf("NewClient() error = %v, want unsafe URL rejection", err)
			}
		})
	}
	for _, rawURL := range []string{"https://example.com", "http://localhost:5177", "http://127.0.0.1:5177", "http://[::1]:5177"} {
		t.Run(rawURL, func(t *testing.T) {
			client, err := NewClient(Config{BaseURL: rawURL, CredentialProvider: credential, MachineID: testMachineID})
			if err != nil {
				t.Fatalf("NewClient() error: %v", err)
			}
			if client.httpClient.Timeout != requestTimeout {
				t.Fatalf("timeout = %s, want %s", client.httpClient.Timeout, requestTimeout)
			}
		})
	}
}

func TestClientRequiresAValidMachineIdentity(t *testing.T) {
	credential := CredentialProviderFunc(func(context.Context) (string, error) { return testToken, nil })
	_, err := NewClient(Config{BaseURL: "https://example.com", CredentialProvider: credential})
	if !errors.Is(err, ErrMissingMachineID) {
		t.Fatalf("NewClient() error = %v, want missing machine identity", err)
	}
	_, err = NewClient(Config{
		BaseURL: "https://example.com", CredentialProvider: credential, MachineID: "machine\r\ninjected",
	})
	if !errors.Is(err, ErrInvalidMachineID) {
		t.Fatalf("NewClient() error = %v, want invalid machine identity", err)
	}
}

func TestClientRejectsUnorderedReadResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(t, writer, http.StatusOK, ReadResult{
			ChannelID:      GeneralChannel,
			Messages:       []Message{testMessage(3, "third"), testMessage(2, "second")},
			AfterSequence:  1,
			NextSequence:   3,
			LatestSequence: 3,
		})
	}))
	t.Cleanup(server.Close)
	client := newTestClient(t, server)
	_, err := client.Read(context.Background(), testThreadID, GeneralChannel, DefaultReadLimit)
	if !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("Read() error = %v, want invalid response", err)
	}
}

func newTestClient(t *testing.T, server *httptest.Server) *Client {
	t.Helper()
	client, err := NewClient(Config{
		BaseURL:    server.URL,
		HTTPClient: server.Client(),
		MachineID:  testMachineID,
		CredentialProvider: CredentialProviderFunc(func(context.Context) (string, error) {
			return testToken, nil
		}),
	})
	if err != nil {
		t.Fatalf("NewClient() error: %v", err)
	}
	return client
}

func testMessage(sequence uint64, body string) Message {
	return Message{
		ID:        fmt.Sprintf("message-%d", sequence),
		ChannelID: GeneralChannel,
		Sequence:  sequence,
		Body:      body,
		Sender: Sender{
			MemberID:    "member-1",
			DisplayName: "Mira",
			Handle:      "mira",
			Role:        "agent",
			Origin:      &Origin{ThreadID: testThreadID, HostID: "host-1", MachineID: "machine-1"},
		},
		CreatedAt: time.Date(2026, 7, 11, 12, 30, 0, 0, time.UTC),
		ExpiresAt: time.Date(2026, 7, 12, 12, 30, 0, 0, time.UTC),
	}
}

func writeJSON(t *testing.T, writer http.ResponseWriter, status int, value any) {
	t.Helper()
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		t.Fatalf("encode response: %v", err)
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (roundTrip roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}
