package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"sort"
	"time"
)

const (
	defaultListenAddress = "0.0.0.0:4180"
	healthcheckURL       = "http://127.0.0.1:4180/healthz"
	defaultSocketPath    = "/var/run/tailscale/tailscaled.sock"
	localAPIHost         = "local-tailscaled.sock"
	localAPIStatusPath   = "/localapi/v0/status"
	upstreamTimeout      = 3 * time.Second
	maximumStatusBytes   = 128 * 1024
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		if err := checkHealth(healthcheckURL); err != nil {
			os.Exit(1)
		}
		return
	}
	if len(os.Args) != 1 {
		os.Exit(2)
	}
	server := &http.Server{
		Addr:              defaultListenAddress,
		Handler:           newStatusProxy(defaultSocketPath),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Print("tailscale status proxy could not start")
		os.Exit(1)
	}
}

func checkHealth(url string) error {
	client := &http.Client{Timeout: upstreamTimeout}
	response, err := client.Get(url)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("tailscale status proxy is unhealthy")
	}
	return nil
}

func newStatusProxy(socketPath string) http.Handler {
	reader := newStatusReader(socketPath)
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			response.Header().Set("Allow", http.MethodGet)
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		if request.URL.RawQuery != "" {
			writeError(response, http.StatusNotFound, "not_found")
			return
		}

		switch request.URL.Path {
		case "/v1/status":
			status, err := reader.read(request.Context())
			if err != nil {
				writeError(response, http.StatusServiceUnavailable, "status_unavailable")
				return
			}
			writeJSON(response, http.StatusOK, status)
		case "/healthz":
			if _, err := reader.read(request.Context()); err != nil {
				writeError(response, http.StatusServiceUnavailable, "status_unavailable")
				return
			}
			writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
		default:
			writeError(response, http.StatusNotFound, "not_found")
		}
	})
}

type statusReader struct {
	client *http.Client
}

func newStatusReader(socketPath string) *statusReader {
	dialer := &net.Dialer{Timeout: upstreamTimeout}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", socketPath)
		},
		DisableCompression:    true,
		ForceAttemptHTTP2:     false,
		ResponseHeaderTimeout: upstreamTimeout,
	}
	return &statusReader{client: &http.Client{Timeout: upstreamTimeout, Transport: transport}}
}

func (reader *statusReader) read(parent context.Context) (statusResponse, error) {
	context, cancel := context.WithTimeout(parent, upstreamTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(
		context,
		http.MethodGet,
		"http://"+localAPIHost+localAPIStatusPath,
		nil,
	)
	if err != nil {
		return statusResponse{}, err
	}
	response, err := reader.client.Do(request)
	if err != nil {
		return statusResponse{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return statusResponse{}, errors.New("tailscale status was unavailable")
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maximumStatusBytes+1))
	if err != nil || len(body) > maximumStatusBytes {
		return statusResponse{}, errors.New("tailscale status response was invalid")
	}
	return decodeStatus(body)
}

type rawStatus struct {
	BackendState string                     `json:"BackendState"`
	Peer         map[string]json.RawMessage `json:"Peer"`
	Self         json.RawMessage            `json:"Self"`
}

type rawPeer struct {
	HostName     string   `json:"HostName"`
	ID           string   `json:"ID"`
	LastSeen     string   `json:"LastSeen"`
	OS           string   `json:"OS"`
	Online       *bool    `json:"Online"`
	Tags         []string `json:"Tags"`
	TailscaleIPs []string `json:"TailscaleIPs"`
}

type statusResponse struct {
	BackendState string                `json:"BackendState"`
	Peer         map[string]statusPeer `json:"Peer"`
	Self         statusPeer            `json:"Self"`
}

type statusPeer struct {
	HostName     string   `json:"HostName"`
	ID           string   `json:"ID"`
	LastSeen     string   `json:"LastSeen,omitempty"`
	OS           string   `json:"OS"`
	Online       *bool    `json:"Online"`
	Tags         []string `json:"Tags"`
	TailscaleIPs []string `json:"TailscaleIPs"`
}

func decodeStatus(body []byte) (statusResponse, error) {
	var raw rawStatus
	if err := json.Unmarshal(body, &raw); err != nil || raw.BackendState != "Running" {
		return statusResponse{}, errors.New("tailscale status response was invalid")
	}
	var self rawPeer
	if err := json.Unmarshal(raw.Self, &self); err != nil || self.ID == "" ||
		self.Online == nil || len(self.TailscaleIPs) == 0 {
		return statusResponse{}, errors.New("tailscale status response was invalid")
	}
	type sortablePeer struct {
		peer    statusPeer
		sortKey string
	}
	peers := make([]sortablePeer, 0, len(raw.Peer))
	for sourceKey, encodedPeer := range raw.Peer {
		var peer rawPeer
		if err := json.Unmarshal(encodedPeer, &peer); err != nil {
			peers = append(peers, sortablePeer{peer: statusPeer{}, sortKey: "\xff" + sourceKey})
			continue
		}
		peers = append(peers, sortablePeer{
			peer: projectPeer(peer), sortKey: peer.ID + "\x00" + sourceKey,
		})
	}
	sort.Slice(peers, func(left, right int) bool { return peers[left].sortKey < peers[right].sortKey })
	projectedPeers := make(map[string]statusPeer, len(peers))
	for index, peer := range peers {
		projectedPeers[peerKey(index)] = peer.peer
	}
	return statusResponse{
		BackendState: raw.BackendState,
		Peer:         projectedPeers,
		Self:         projectPeer(self),
	}, nil
}

func peerKey(index int) string {
	const digits = "0123456789"
	key := []byte("peer-000000")
	for position := len(key) - 1; position >= len("peer-"); position-- {
		key[position] = digits[index%10]
		index /= 10
	}
	return string(key)
}

func projectPeer(peer rawPeer) statusPeer {
	return statusPeer{
		HostName:     peer.HostName,
		ID:           peer.ID,
		LastSeen:     peer.LastSeen,
		OS:           peer.OS,
		Online:       peer.Online,
		Tags:         peer.Tags,
		TailscaleIPs: peer.TailscaleIPs,
	}
}

func writeError(response http.ResponseWriter, status int, code string) {
	writeJSON(response, status, map[string]string{"error": code})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
