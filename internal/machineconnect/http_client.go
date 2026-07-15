package machineconnect

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

const (
	defaultHTTPTimeout = 15 * time.Second
	maxResponseBytes   = 1 << 20
)

type HTTPBackend struct {
	baseURL *url.URL
	client  *http.Client
}

func NewHTTPBackend(baseURL string, client *http.Client) (*HTTPBackend, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("backend URL must be an absolute HTTP or HTTPS URL")
	}
	if parsed.Scheme != "https" && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" {
		return nil, errors.New("backend URL must use HTTPS")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("backend URL must not contain credentials, a query, or a fragment")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")

	if client == nil {
		client = &http.Client{Timeout: defaultHTTPTimeout}
	} else {
		clone := *client
		client = &clone
		if client.Timeout == 0 {
			client.Timeout = defaultHTTPTimeout
		}
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}

	return &HTTPBackend{baseURL: parsed, client: client}, nil
}

func (backend *HTTPBackend) Health(ctx context.Context) error {
	return backend.doJSON(ctx, http.MethodGet, "/api/health", "", nil, nil)
}

func (backend *HTTPBackend) CreateRequest(
	ctx context.Context,
	machine Machine,
	machineKey MachineKey,
) (Request, error) {
	publicKey, err := machineKey.PublicKey()
	if err != nil {
		return Request{}, errors.New("create machine connection request: invalid machine identity key")
	}
	payload := struct {
		Architecture     string `json:"architecture"`
		ClientVersion    string `json:"clientVersion"`
		ConnectorProfile *struct {
			Channel string `json:"channel"`
			Source  string `json:"source"`
		} `json:"connectorProfile,omitempty"`
		Hostname        string `json:"hostname"`
		Name            string `json:"name"`
		OperatingSystem string `json:"operatingSystem"`
		PublicKey       string `json:"publicKey"`
	}{
		Architecture: machine.Architecture, ClientVersion: machine.ClientVersion,
		Hostname: machine.Hostname, Name: machine.Name, OperatingSystem: machine.OS,
		PublicKey: publicKey,
	}
	if machine.Channel != "" || machine.Source != "" {
		payload.ConnectorProfile = &struct {
			Channel string `json:"channel"`
			Source  string `json:"source"`
		}{Channel: machine.Channel, Source: machine.Source}
	}
	response := struct {
		RequestID      string `json:"requestId"`
		PollToken      string `json:"pollToken"`
		ApprovalURL    string `json:"approvalUrl"`
		ExpiresAt      string `json:"expiresAt"`
		PollIntervalMS int64  `json:"pollIntervalMs"`
	}{}
	if err := backend.doJSON(ctx, http.MethodPost, "/api/machine-connections", "", payload, &response); err != nil {
		return Request{}, fmt.Errorf("create machine connection request: %w", err)
	}

	expiresAt, err := time.Parse(time.RFC3339, response.ExpiresAt)
	if err != nil || expiresAt.IsZero() {
		return Request{}, errors.New("create machine connection request: backend returned an invalid expiry")
	}
	if !validIdentifier(response.RequestID) || !validOpaqueValue(response.PollToken) {
		return Request{}, errors.New("create machine connection request: backend returned invalid request credentials")
	}
	if err := validateApprovalURL(response.ApprovalURL, backend.baseURL); err != nil {
		return Request{}, fmt.Errorf("create machine connection request: %w", err)
	}
	interval := time.Duration(response.PollIntervalMS) * time.Millisecond
	if interval <= 0 {
		interval = 2 * time.Second
	}

	return Request{
		ID:           response.RequestID,
		PollToken:    response.PollToken,
		ApprovalURL:  response.ApprovalURL,
		ExpiresAt:    expiresAt,
		PollInterval: interval,
	}, nil
}

func (backend *HTTPBackend) PollRequest(ctx context.Context, request Request) (Approval, error) {
	if !validIdentifier(request.ID) || !validOpaqueValue(request.PollToken) {
		return Approval{}, errors.New("check machine connection approval: invalid request credentials")
	}
	response := struct {
		Status            ApprovalState `json:"status"`
		ApprovalChallenge string        `json:"approvalChallenge"`
		RetryAfterMS      int64         `json:"retryAfterMs"`
	}{}
	endpoint := path.Join("/api/machine-connections", request.ID)
	if err := backend.doJSON(ctx, http.MethodGet, endpoint, request.PollToken, nil, &response); err != nil {
		return Approval{}, fmt.Errorf("check machine connection approval: %w", err)
	}
	if response.Status != ApprovalPending && response.Status != ApprovalApproved &&
		response.Status != ApprovalDenied && response.Status != ApprovalExpired && response.Status != ApprovalConsumed {
		return Approval{}, errors.New("check machine connection approval: backend returned an invalid status")
	}
	if response.Status == ApprovalApproved && !validOpaqueValue(response.ApprovalChallenge) {
		return Approval{}, errors.New("check machine connection approval: backend returned an invalid approval challenge")
	}
	return Approval{
		State:      response.Status,
		Challenge:  response.ApprovalChallenge,
		RetryAfter: time.Duration(response.RetryAfterMS) * time.Millisecond,
	}, nil
}

func (backend *HTTPBackend) Exchange(
	ctx context.Context,
	request Request,
	challenge string,
	machineKey MachineKey,
) (Credential, error) {
	if !validIdentifier(request.ID) || !validOpaqueValue(request.PollToken) || !validOpaqueValue(challenge) {
		return Credential{}, errors.New("exchange machine connection approval: invalid machine proof material")
	}
	message := []byte("project-space-machine-connect:v1:" + request.ID + ":" + challenge)
	signature, err := machineKey.Sign(message)
	if err != nil {
		return Credential{}, errors.New("exchange machine connection approval: invalid machine identity key")
	}
	payload := struct {
		Signature string `json:"signature"`
	}{Signature: base64.RawURLEncoding.EncodeToString(signature)}
	response := struct {
		MachineID   string `json:"machineId"`
		MachineName string `json:"machineName"`
		Credential  string `json:"credential"`
		IssuedAt    string `json:"issuedAt"`
	}{}
	endpoint := path.Join("/api/machine-connections", request.ID, "exchange")
	if err := backend.doJSON(ctx, http.MethodPost, endpoint, request.PollToken, payload, &response); err != nil {
		return Credential{}, fmt.Errorf("exchange machine connection approval: %w", err)
	}
	if !validIdentifier(response.MachineID) || strings.TrimSpace(response.MachineName) == "" ||
		!validOpaqueValue(response.Credential) {
		return Credential{}, errors.New("exchange machine connection approval: backend returned invalid machine credentials")
	}
	issuedAt := time.Now().UTC()
	if response.IssuedAt != "" {
		parsed, err := time.Parse(time.RFC3339, response.IssuedAt)
		if err != nil {
			return Credential{}, errors.New("exchange machine connection approval: backend returned an invalid issue time")
		}
		issuedAt = parsed
	}
	return Credential{
		BackendURL:  backend.baseURL.String(),
		MachineID:   response.MachineID,
		MachineName: strings.TrimSpace(response.MachineName),
		Token:       response.Credential,
		IssuedAt:    issuedAt,
	}, nil
}

func (backend *HTTPBackend) Connection(ctx context.Context, credential Credential) (ConnectionState, error) {
	if err := backend.validateCredential(credential); err != nil {
		return "", fmt.Errorf("check machine connection: %w", err)
	}
	response := struct {
		Status ConnectionState `json:"status"`
	}{}
	endpoint := path.Join("/api/machines", credential.MachineID, "connection")
	if err := backend.doJSON(ctx, http.MethodGet, endpoint, credential.Token, nil, &response); err != nil {
		return "", fmt.Errorf("check machine connection: %w", err)
	}
	if response.Status != ConnectionOffline && response.Status != ConnectionOnline && response.Status != ConnectionRevoked {
		return "", errors.New("check machine connection: backend returned an invalid status")
	}
	return response.Status, nil
}

func (backend *HTTPBackend) Revoke(ctx context.Context, credential Credential) error {
	if err := backend.validateCredential(credential); err != nil {
		return fmt.Errorf("revoke machine connection: %w", err)
	}
	endpoint := path.Join("/api/machines", credential.MachineID, "revoke")
	if err := backend.doJSON(ctx, http.MethodPost, endpoint, credential.Token, nil, nil); err != nil {
		return fmt.Errorf("revoke machine connection: %w", err)
	}
	return nil
}

func (backend *HTTPBackend) validateCredential(credential Credential) error {
	if err := validateCredential(credential); err != nil {
		return err
	}
	if strings.TrimRight(credential.BackendURL, "/") != strings.TrimRight(backend.baseURL.String(), "/") {
		return errors.New("machine credential belongs to a different backend")
	}
	return nil
}

func (backend *HTTPBackend) doJSON(
	ctx context.Context,
	method string,
	endpoint string,
	bearerToken string,
	payload any,
	result any,
) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return errors.New("encode backend request")
		}
		body = bytes.NewReader(encoded)
	}

	requestURL := *backend.baseURL
	requestURL.Path = strings.TrimRight(backend.baseURL.Path, "/") + endpoint
	request, err := http.NewRequestWithContext(ctx, method, requestURL.String(), body)
	if err != nil {
		return errors.New("build backend request")
	}
	request.Header.Set("Accept", "application/json")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if bearerToken != "" {
		if !validOpaqueValue(bearerToken) {
			return errors.New("invalid backend authorization credential")
		}
		request.Header.Set("Authorization", "Bearer "+bearerToken)
	}

	response, err := backend.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("backend request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		return fmt.Errorf("backend returned HTTP %d", response.StatusCode)
	}
	if result == nil || response.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		return nil
	}

	limited := io.LimitReader(response.Body, maxResponseBytes+1)
	encoded, err := io.ReadAll(limited)
	if err != nil {
		return errors.New("read backend response")
	}
	if len(encoded) > maxResponseBytes {
		return errors.New("backend response is too large")
	}
	if err := json.Unmarshal(encoded, result); err != nil {
		return errors.New("backend returned invalid JSON")
	}
	return nil
}

func validateApprovalURL(value string, backendURL *url.URL) error {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return errors.New("backend returned an invalid approval URL")
	}
	if parsed.User != nil || parsed.Scheme == "http" && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" {
		return errors.New("backend returned an insecure approval URL")
	}
	if backendURL == nil || parsed.Scheme != backendURL.Scheme || parsed.Host != backendURL.Host {
		return errors.New("backend returned a cross-origin approval URL")
	}
	return nil
}

func validOpaqueValue(value string) bool {
	trimmed := strings.TrimSpace(value)
	return trimmed != "" && trimmed == value && len(value) <= 4096 && !strings.ContainsAny(value, "\r\n\x00")
}

func validIdentifier(value string) bool {
	if !validOpaqueValue(value) || len(value) > 256 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || strings.ContainsRune("-_.~", character) {
			continue
		}
		return false
	}
	return true
}
