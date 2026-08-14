package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStatusProxyReadsOnlyFixedLocalAPIStatusAndProjectsMinimalFields(t *testing.T) {
	var method, path, query string
	proxy := testProxy(t, func(response http.ResponseWriter, request *http.Request) {
		method, path, query = request.Method, request.URL.Path, request.URL.RawQuery
		_, _ = response.Write([]byte(`{
			"BackendState":"Running",
			"Self":{"ID":"node-self","HostName":"os-pc","OS":"linux","Tags":["tag:developer"],"TailscaleIPs":["100.64.0.1"],"Online":true,"LastSeen":"2026-08-14T10:00:00Z","DNSName":"secret.ts.net","PublicKey":"secret-public-key"},
			"Peer":{"public-key-one":{"ID":"node-b","HostName":"os-b","OS":"windows","Tags":[],"TailscaleIPs":["100.64.0.2"],"Online":false,"LastSeen":"2026-08-14T09:00:00Z","Relay":"secret-relay"},"public-key-two":{"ID":"node-a","HostName":"os-a","OS":"linux","Tags":["tag:ops"],"TailscaleIPs":["100.64.0.3"],"Online":true}}
		}`))
	})

	response := request(t, proxy, http.MethodGet, "/v1/status")
	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d", response.Code, http.StatusOK)
	}
	if method != http.MethodGet || path != localAPIStatusPath || query != "" {
		t.Fatalf("upstream request = %s %s?%s", method, path, query)
	}
	if strings.Contains(response.Body.String(), "secret") || strings.Contains(response.Body.String(), "public-key") {
		t.Fatalf("proxy leaked raw upstream fields: %s", response.Body.String())
	}
	var status statusResponse
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.BackendState != "Running" || status.Self.ID != "node-self" || len(status.Peer) != 2 {
		t.Fatalf("unexpected status projection: %+v", status)
	}
	if status.Peer["peer-000000"].ID != "node-a" || status.Peer["peer-000001"].ID != "node-b" {
		t.Fatalf("peers are not sorted behind synthetic keys: %+v", status.Peer)
	}
}

func TestStatusProxyDoesNotFabricateMissingOnlineEvidence(t *testing.T) {
	proxy := testProxy(t, func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte(`{"BackendState":"Running","Self":{"ID":"node-self","TailscaleIPs":["100.64.0.1"]}}`))
	})
	response := request(t, proxy, http.MethodGet, "/v1/status")
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status code = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
}

func TestStatusProxyPreservesHealthyPeersWhenOnePeerIsMalformed(t *testing.T) {
	proxy := testProxy(t, func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte(`{
			"BackendState":"Running",
			"Self":{"ID":"node-self","TailscaleIPs":["100.64.0.1"],"Online":true},
			"Peer":{
				"public-key-malformed":{"ID":{"secret":"do-not-leak"},"TailscaleIPs":["100.64.0.2"],"Online":true},
				"public-key-healthy":{"ID":"node-healthy","TailscaleIPs":["100.64.0.3"],"Online":true}
			}
		}`))
	})
	response := request(t, proxy, http.MethodGet, "/v1/status")
	if response.Code != http.StatusOK {
		t.Fatalf("status code = %d, want %d", response.Code, http.StatusOK)
	}
	if strings.Contains(response.Body.String(), "secret") || strings.Contains(response.Body.String(), "public-key") {
		t.Fatalf("proxy leaked malformed peer data: %s", response.Body.String())
	}
	var status statusResponse
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if len(status.Peer) != 2 || status.Peer["peer-000000"].ID != "node-healthy" ||
		status.Peer["peer-000001"].ID != "" {
		t.Fatalf("healthy peer was not preserved with a sanitized malformed peer: %+v", status.Peer)
	}
}

func TestStatusProxyRejectsOtherMethodsRoutesAndQueries(t *testing.T) {
	proxy := testProxy(t, func(response http.ResponseWriter, _ *http.Request) {
		t.Fatal("upstream should not be reached")
		response.WriteHeader(http.StatusInternalServerError)
	})
	for _, test := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodPost, "/v1/status", http.StatusMethodNotAllowed},
		{http.MethodGet, "/v1/status?socket=/tmp/attacker", http.StatusNotFound},
		{http.MethodGet, "/v1/other", http.StatusNotFound},
	} {
		response := request(t, proxy, test.method, test.path)
		if response.Code != test.status {
			t.Errorf("%s %s = %d, want %d", test.method, test.path, response.Code, test.status)
		}
		if strings.Contains(response.Body.String(), "attacker") {
			t.Errorf("unsafe response body: %s", response.Body.String())
		}
	}
}

func TestStatusProxyBoundsAndSanitizesMalformedResponses(t *testing.T) {
	for _, body := range [][]byte{
		[]byte(`{"BackendState":"Running","Self":{"ID":"node-self"},"secret":"do-not-leak"`),
		append([]byte(`{"BackendState":"Running","Self":{"ID":"node-self"},"padding":"`), append(make([]byte, maximumStatusBytes), []byte(`"}`)...)...),
	} {
		proxy := testProxy(t, func(response http.ResponseWriter, _ *http.Request) {
			_, _ = response.Write(body)
		})
		response := request(t, proxy, http.MethodGet, "/v1/status")
		if response.Code != http.StatusServiceUnavailable {
			t.Errorf("status code = %d, want %d", response.Code, http.StatusServiceUnavailable)
		}
		if response.Body.String() != "{\"error\":\"status_unavailable\"}\n" {
			t.Errorf("unsafe error body: %q", response.Body.String())
		}
	}
}

func TestHealthzVerifiesSocketStatusRead(t *testing.T) {
	proxy := newStatusProxy(filepath.Join(t.TempDir(), "missing.sock"))
	response := request(t, proxy, http.MethodGet, "/healthz")
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("health status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	if response.Body.String() != "{\"error\":\"status_unavailable\"}\n" {
		t.Fatalf("health body = %q", response.Body.String())
	}
}

func TestHealthcheckRequiresSuccessfulHealthEndpoint(t *testing.T) {
	healthyServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/healthz" {
			t.Fatalf("healthcheck path = %q", request.URL.Path)
		}
		response.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(healthyServer.Close)
	if err := checkHealth(healthyServer.URL + "/healthz"); err != nil {
		t.Fatalf("healthy endpoint failed: %v", err)
	}

	unhealthyServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(unhealthyServer.Close)
	if err := checkHealth(unhealthyServer.URL + "/healthz"); err == nil {
		t.Fatal("unhealthy endpoint unexpectedly passed")
	}
}

func testProxy(t *testing.T, upstream http.HandlerFunc) http.Handler {
	t.Helper()
	file, err := os.CreateTemp("", "tsp-*")
	if err != nil {
		t.Fatal(err)
	}
	socketPath := file.Name()
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(socketPath); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	server := &http.Server{Handler: upstream}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	return newStatusProxy(socketPath)
}

func request(t *testing.T, handler http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
