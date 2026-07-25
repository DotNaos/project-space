package machineresources

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maximumResponseBytes int64 = 1 << 20

type Config struct {
	BaseURL         string
	CallerMachineID string
	Token           string
	HTTPClient      *http.Client
}

type Client struct {
	baseURL         *url.URL
	callerMachineID string
	httpClient      *http.Client
	token           string
}

func NewClient(config Config) (*Client, error) {
	baseURL, err := parseBaseURL(config.BaseURL)
	if err != nil || !validOpaque(config.CallerMachineID, 256) || !validOpaque(config.Token, 4096) {
		return nil, errors.New("invalid machine resources client configuration")
	}
	client := http.Client{Timeout: 15 * time.Second}
	if config.HTTPClient != nil {
		client = *config.HTTPClient
		if client.Timeout == 0 {
			client.Timeout = 15 * time.Second
		}
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{
		baseURL: baseURL, callerMachineID: config.CallerMachineID,
		httpClient: &client, token: config.Token,
	}, nil
}

func (client *Client) List(ctx context.Context) (Result, error) {
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(client.baseURL.Path, "/") + "/api/machine-resources"
	endpoint.RawPath, endpoint.RawQuery, endpoint.Fragment = "", "", ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return Result{}, errors.New("build machine resources request")
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("X-Project-Machine-ID", client.callerMachineID)
	response, err := client.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		return Result{}, errors.New("machine resources request failed")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil || int64(len(body)) > maximumResponseBytes {
		return Result{}, errors.New("read machine resources response")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Result{}, fmt.Errorf("machine resources backend returned HTTP %d", response.StatusCode)
	}
	result, err := decodeResult(body)
	if err != nil {
		return Result{}, err
	}
	if err := validateResult(result); err != nil {
		return Result{}, err
	}
	return result, nil
}

func decodeResult(body []byte) (Result, error) {
	var direct Result
	if json.Unmarshal(body, &direct) == nil && (direct.CheckedAt != "" || direct.Machines != nil) {
		return direct, nil
	}
	var envelope struct {
		Result Result `json:"result"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return Result{}, errors.New("machine resources backend returned invalid JSON")
	}
	return envelope.Result, nil
}

func parseBaseURL(value string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, errors.New("invalid backend URL")
	}
	if parsed.Scheme != "https" && parsed.Hostname() != "127.0.0.1" &&
		parsed.Hostname() != "localhost" && parsed.Hostname() != "::1" {
		return nil, errors.New("backend URL must use HTTPS")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed, nil
}

func validOpaque(value string, maximum int) bool {
	return value != "" && strings.TrimSpace(value) == value && len(value) <= maximum &&
		!strings.ContainsAny(value, "\r\n\x00")
}
