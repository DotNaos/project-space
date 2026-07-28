package projectcatalog

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const maximumResponseBytes int64 = 2 << 20

var (
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`)
	projectIDPattern  = regexp.MustCompile(`^github:[1-9][0-9]*$`)
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	tokenPattern      = regexp.MustCompile(`^[A-Za-z0-9._~+/-]+=*$`)
	errorCodePattern  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
)

type Config struct {
	BaseURL            string
	CallerMachineID    string
	CredentialProvider CredentialProvider
	HTTPClient         *http.Client
}

type Client struct {
	baseURL         *url.URL
	callerMachineID string
	credentials     CredentialProvider
	httpClient      *http.Client
}

func NewClient(config Config) (*Client, error) {
	baseURL, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil || baseURL.Host == "" ||
		(baseURL.Scheme != "http" && baseURL.Scheme != "https") ||
		baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" ||
		!identifierPattern.MatchString(config.CallerMachineID) ||
		config.CredentialProvider == nil {
		return nil, ErrInvalidConfig
	}
	if baseURL.Scheme != "https" && baseURL.Hostname() != "localhost" &&
		baseURL.Hostname() != "127.0.0.1" && baseURL.Hostname() != "::1" {
		return nil, ErrInvalidConfig
	}
	client := http.Client{Timeout: 10 * time.Second}
	if config.HTTPClient != nil {
		client = *config.HTTPClient
		if client.Timeout == 0 {
			client.Timeout = 10 * time.Second
		}
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	baseURL.Path = strings.TrimRight(baseURL.Path, "/")
	return &Client{
		baseURL:         baseURL,
		callerMachineID: config.CallerMachineID,
		credentials:     config.CredentialProvider,
		httpClient:      &client,
	}, nil
}

func (client *Client) List(ctx context.Context) (Catalog, error) {
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(client.baseURL.Path, "/") + "/api/projects/catalog"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return Catalog{}, ErrInvalidConfig
	}
	token, err := client.credentials.AccessToken(ctx)
	if err != nil || len(token) > 4096 || !tokenPattern.MatchString(token) {
		return Catalog{}, ErrUnauthorized
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Project-Machine-ID", client.callerMachineID)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return Catalog{}, ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Catalog{}, decodeFailure(response)
	}
	var catalog Catalog
	if err := decodeBoundedJSON(response.Body, &catalog); err != nil {
		return Catalog{}, ErrInvalidResponse
	}
	if err := validateCatalog(&catalog); err != nil {
		return Catalog{}, err
	}
	return catalog, nil
}

func decodeFailure(response *http.Response) error {
	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if decodeBoundedJSON(response.Body, &payload) == nil &&
		errorCodePattern.MatchString(payload.Error.Code) &&
		len(payload.Error.Message) <= 1024 {
		return &APIError{
			Code:       payload.Error.Code,
			Message:    payload.Error.Message,
			StatusCode: response.StatusCode,
		}
	}
	switch {
	case response.StatusCode == http.StatusUnauthorized ||
		response.StatusCode == http.StatusForbidden:
		return ErrUnauthorized
	case response.StatusCode == http.StatusTooManyRequests ||
		response.StatusCode >= http.StatusInternalServerError:
		return ErrUnavailable
	default:
		return ErrInvalidResponse
	}
}

func decodeBoundedJSON(reader io.Reader, destination any) error {
	limited := &io.LimitedReader{R: reader, N: maximumResponseBytes + 1}
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if limited.N == 0 {
		return ErrInvalidResponse
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return ErrInvalidResponse
	}
	return nil
}

func validateCatalog(catalog *Catalog) error {
	if catalog.SchemaVersion != 1 || catalog.Projects == nil ||
		!validCatalogStatus(catalog.Catalog.Status) ||
		!validCacheState(catalog.Catalog.CacheState) {
		return ErrInvalidResponse
	}
	if _, err := time.Parse(time.RFC3339Nano, catalog.Catalog.CheckedAt); err != nil {
		return ErrInvalidResponse
	}
	ids := make(map[string]struct{}, len(catalog.Projects))
	repositories := make(map[string]struct{}, len(catalog.Projects))
	for _, project := range catalog.Projects {
		repositoryKey := strings.ToLower(project.Repository)
		if !projectIDPattern.MatchString(project.ID) ||
			project.DisplayName == "" || len(project.DisplayName) > 255 ||
			!repositoryPattern.MatchString(project.Repository) ||
			project.LocalCandidates == nil {
			return ErrInvalidResponse
		}
		if _, exists := ids[project.ID]; exists {
			return ErrInvalidResponse
		}
		if _, exists := repositories[repositoryKey]; exists {
			return ErrInvalidResponse
		}
		ids[project.ID] = struct{}{}
		repositories[repositoryKey] = struct{}{}
		paths := make(map[string]struct{}, len(project.LocalCandidates))
		for _, candidate := range project.LocalCandidates {
			if candidate.ProjectID == "" || len(candidate.ProjectID) > 2048 ||
				!filepath.IsAbs(candidate.Path) || len(candidate.Path) > 4096 {
				return ErrInvalidResponse
			}
			key := filepath.Clean(candidate.Path)
			if _, exists := paths[key]; exists {
				return ErrInvalidResponse
			}
			paths[key] = struct{}{}
		}
	}
	sort.Slice(catalog.Projects, func(i, j int) bool {
		left := strings.ToLower(catalog.Projects[i].Repository)
		right := strings.ToLower(catalog.Projects[j].Repository)
		if left == right {
			leftID, _ := strconv.Atoi(strings.TrimPrefix(catalog.Projects[i].ID, "github:"))
			rightID, _ := strconv.Atoi(strings.TrimPrefix(catalog.Projects[j].ID, "github:"))
			return leftID < rightID
		}
		return left < right
	})
	return nil
}

func validCatalogStatus(status string) bool {
	switch status {
	case "connected", "auth-required", "unauthorized", "not-configured", "rate-limited", "error":
		return true
	default:
		return false
	}
}

func validCacheState(state string) bool {
	switch state {
	case "", "miss", "fresh", "stale", "refreshing", "refresh-failed":
		return true
	default:
		return false
	}
}
