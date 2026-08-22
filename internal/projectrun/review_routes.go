package projectrun

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	defaultReviewRouteAPIURL = "https://projects.vpn.os-home.net/platform/v1/review-routes"
	reviewRouteLeaseSeconds  = 120
	reviewRouteRenewInterval = 45 * time.Second
	maxReviewRouteResponse   = 64 << 10
)

const ReviewRouteHeartbeatCommandName = "__review-route-heartbeat"

type ReviewRoute struct {
	ID          string    `json:"id"`
	ProjectSlug string    `json:"project_slug"`
	TaskID      string    `json:"task_id"`
	Hostname    string    `json:"hostname"`
	BackendIP   string    `json:"backend_ip"`
	BackendPort int       `json:"backend_port"`
	Status      string    `json:"status"`
	Owner       string    `json:"owner"`
	ExpiresAt   time.Time `json:"expires_at"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type ReviewRouteCreate struct {
	ProjectSlug  string `json:"project_slug"`
	TaskID       string `json:"task_id"`
	BackendIP    string `json:"backend_ip"`
	BackendPort  int    `json:"backend_port"`
	LeaseSeconds int    `json:"lease_seconds"`
	LeaseToken   string `json:"lease_token"`
}

type ReviewRouteAPI interface {
	Create(context.Context, string, ReviewRouteCreate) (ReviewRoute, error)
	Renew(context.Context, string, string, string, int) (ReviewRoute, error)
	Delete(context.Context, string, string, string) error
}

type HTTPReviewRouteAPI struct {
	Endpoint string
	Client   *http.Client
}

func (api HTTPReviewRouteAPI) Create(
	ctx context.Context,
	apiToken string,
	input ReviewRouteCreate,
) (ReviewRoute, error) {
	var route ReviewRoute
	if err := api.request(ctx, http.MethodPost, api.endpoint(), apiToken, input, &route); err != nil {
		return ReviewRoute{}, fmt.Errorf("create review route: %w", err)
	}
	return route, nil
}

func (api HTTPReviewRouteAPI) Renew(
	ctx context.Context,
	apiToken string,
	routeID string,
	leaseToken string,
	leaseSeconds int,
) (ReviewRoute, error) {
	var route ReviewRoute
	endpoint := api.endpoint() + "/" + url.PathEscape(routeID) + "/renew"
	input := map[string]any{"lease_seconds": leaseSeconds, "lease_token": leaseToken}
	if err := api.request(ctx, http.MethodPost, endpoint, apiToken, input, &route); err != nil {
		return ReviewRoute{}, fmt.Errorf("renew review route: %w", err)
	}
	return route, nil
}

func (api HTTPReviewRouteAPI) Delete(
	ctx context.Context,
	apiToken string,
	routeID string,
	leaseToken string,
) error {
	endpoint := api.endpoint() + "/" + url.PathEscape(routeID)
	err := api.request(ctx, http.MethodDelete, endpoint, apiToken, map[string]string{
		"lease_token": leaseToken,
	}, nil)
	if errors.Is(err, errReviewRouteNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("delete review route: %w", err)
	}
	return nil
}

var errReviewRouteNotFound = errors.New("review route not found")

func (api HTTPReviewRouteAPI) request(
	ctx context.Context,
	method string,
	endpoint string,
	apiToken string,
	input any,
	output any,
) error {
	if strings.TrimSpace(apiToken) == "" {
		return fmt.Errorf("API token is required")
	}
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+apiToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	client := api.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, maxReviewRouteResponse)
	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, limited)
		return errReviewRouteNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		payload, _ := io.ReadAll(limited)
		message := struct {
			Error string `json:"error"`
		}{}
		_ = json.Unmarshal(payload, &message)
		if strings.TrimSpace(message.Error) == "" {
			message.Error = response.Status
		}
		return fmt.Errorf("review route API returned %s: %s", response.Status, message.Error)
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		_, _ = io.Copy(io.Discard, limited)
		return nil
	}
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return fmt.Errorf("decode review route response: %w", err)
	}
	return nil
}

func (api HTTPReviewRouteAPI) endpoint() string {
	endpoint := strings.TrimRight(strings.TrimSpace(api.Endpoint), "/")
	if endpoint == "" {
		return defaultReviewRouteAPIURL
	}
	return endpoint
}

func normalizeReviewRouteLabel(raw string) (string, error) {
	value := strings.Trim(strings.Map(func(character rune) rune {
		switch {
		case character >= 'a' && character <= 'z':
			return character
		case character >= 'A' && character <= 'Z':
			return character + ('a' - 'A')
		case character >= '0' && character <= '9':
			return character
		default:
			return '-'
		}
	}, strings.TrimSpace(raw)), "-")
	for strings.Contains(value, "--") {
		value = strings.ReplaceAll(value, "--", "-")
	}
	if !dnsLabelPattern.MatchString(value) {
		return "", fmt.Errorf("value %q cannot be normalized to one DNS label", raw)
	}
	return value, nil
}

func expectedReviewHostname(projectSlug, taskID string) (string, string, string, error) {
	project, err := normalizeReviewRouteLabel(projectSlug)
	if err != nil {
		return "", "", "", fmt.Errorf("project slug: %w", err)
	}
	task, err := normalizeReviewRouteLabel(taskID)
	if err != nil {
		return "", "", "", fmt.Errorf("task ID: %w", err)
	}
	label := project + "-" + task
	if len(label) > 63 {
		return "", "", "", fmt.Errorf("normalized project and task exceed one DNS label")
	}
	return label + ".review.vpn.os-home.net", project, task, nil
}

func RunReviewRouteHeartbeat(ctx context.Context) error {
	routeID := strings.TrimSpace(os.Getenv("PROJECT_REVIEW_ROUTE_ID"))
	leaseToken := os.Getenv("PROJECT_REVIEW_ROUTE_LEASE_TOKEN")
	apiToken := os.Getenv(reviewRouteAPITokenName)
	backendIP := strings.TrimSpace(os.Getenv("PROJECT_REVIEW_ROUTE_BACKEND_IP"))
	backendPort, err := strconv.Atoi(os.Getenv("PROJECT_REVIEW_ROUTE_BACKEND_PORT"))
	if err != nil || routeID == "" || len(leaseToken) < 32 || strings.TrimSpace(apiToken) == "" ||
		backendPort < 1 || backendPort > 65535 {
		return fmt.Errorf("review route heartbeat environment is invalid")
	}
	leaseSeconds, err := strconv.Atoi(os.Getenv("PROJECT_REVIEW_ROUTE_LEASE_SECONDS"))
	if err != nil || leaseSeconds < 30 || leaseSeconds > 900 {
		return fmt.Errorf("review route heartbeat lease is invalid")
	}
	healthPath := strings.TrimSpace(os.Getenv("PROJECT_REVIEW_ROUTE_HEALTH_PATH"))
	if healthPath == "" || healthPath[0] != '/' {
		return fmt.Errorf("review route heartbeat health path is invalid")
	}
	api := HTTPReviewRouteAPI{Endpoint: os.Getenv("PROJECT_REVIEW_ROUTE_API_URL")}
	ticker := time.NewTicker(reviewRouteRenewInterval)
	defer ticker.Stop()
	deleteRoute := func() error {
		deleteCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		return api.Delete(deleteCtx, apiToken, routeID, leaseToken)
	}
	for {
		select {
		case <-ctx.Done():
			return errors.Join(ctx.Err(), deleteRoute())
		case <-ticker.C:
			checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			healthErr := (NetworkProber{}).Check(checkCtx, ProbeTarget{
				Host: backendIP, Port: backendPort, Path: healthPath,
			})
			cancel()
			if healthErr != nil {
				return errors.Join(fmt.Errorf("review backend health check failed: %w", healthErr), deleteRoute())
			}
			renewCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			_, renewErr := api.Renew(renewCtx, apiToken, routeID, leaseToken, leaseSeconds)
			cancel()
			if renewErr != nil {
				return renewErr
			}
		}
	}
}
