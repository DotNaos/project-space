package roadmap

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Keep this aligned with the server's maximumGraphResponseBytes.
const maximumResponseBytes = 4 << 20

var (
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`)
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	revisionPattern   = regexp.MustCompile(`^[a-f0-9]{8,64}$`)
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
	client := http.Client{Timeout: 60 * time.Second}
	if config.HTTPClient != nil {
		client = *config.HTTPClient
		if client.Timeout == 0 {
			client.Timeout = 60 * time.Second
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

func (client *Client) Get(ctx context.Context, repository string) (Graph, error) {
	if !repositoryPattern.MatchString(repository) {
		return Graph{}, ErrInvalidInput
	}
	query := url.Values{"fullName": []string{repository}}
	return client.do(ctx, http.MethodGet, "/api/roadmap", query, nil, repository)
}

func (client *Client) AddDependency(
	ctx context.Context,
	request MutationRequest,
) (Graph, error) {
	return client.mutate(ctx, http.MethodPost, request)
}

func (client *Client) RemoveDependency(
	ctx context.Context,
	request MutationRequest,
) (Graph, error) {
	return client.mutate(ctx, http.MethodDelete, request)
}

func (client *Client) mutate(
	ctx context.Context,
	method string,
	request MutationRequest,
) (Graph, error) {
	if !validMutation(request) {
		return Graph{}, ErrInvalidInput
	}
	payload := struct {
		BlockedIssueNumber int `json:"blockedIssueNumber"`
		Blocker            struct {
			FullName    string `json:"fullName"`
			IssueNumber int    `json:"issueNumber"`
		} `json:"blocker"`
		ExpectedGraphRevision string `json:"expectedGraphRevision"`
		FullName              string `json:"fullName"`
	}{
		BlockedIssueNumber:    request.BlockedIssueNumber,
		ExpectedGraphRevision: request.ExpectedGraphRevision,
		FullName:              request.Repository,
	}
	payload.Blocker.FullName = request.BlockerRepository
	payload.Blocker.IssueNumber = request.BlockerIssueNumber
	return client.do(
		ctx,
		method,
		"/api/roadmap/dependencies",
		nil,
		payload,
		request.Repository,
	)
}

func (client *Client) do(
	ctx context.Context,
	method string,
	path string,
	query url.Values,
	payload any,
	expectedRepository string,
) (Graph, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return Graph{}, ErrInvalidInput
		}
		body = bytes.NewReader(encoded)
	}
	endpoint := *client.baseURL
	endpoint.Path = strings.TrimRight(client.baseURL.Path, "/") + path
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return Graph{}, ErrInvalidInput
	}
	token, err := client.credentials.AccessToken(ctx)
	if err != nil || !validCredential(token) {
		return Graph{}, ErrUnauthorized
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Project-Machine-ID", client.callerMachineID)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return Graph{}, ctx.Err()
		}
		return Graph{}, ErrUnavailable
	}
	defer response.Body.Close()
	encoded, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil || len(encoded) > maximumResponseBytes {
		return Graph{}, ErrInvalidResponse
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return Graph{}, responseError(response.StatusCode, encoded)
	}
	var graph Graph
	if json.Unmarshal(encoded, &graph) != nil {
		return Graph{}, ErrInvalidResponse
	}
	if graph.Issues == nil {
		graph.Issues = make([]Issue, len(graph.Nodes))
		for index, node := range graph.Nodes {
			graph.Issues[index] = Issue{
				NodeReference: node.NodeReference,
				Description:   node.Description,
				Title:         node.Title,
				URL:           node.URL,
			}
		}
	}
	if validateGraph(graph, expectedRepository) != nil {
		return Graph{}, ErrInvalidResponse
	}
	return graph, nil
}

func validMutation(request MutationRequest) bool {
	return request.BlockedIssueNumber > 0 &&
		request.BlockerIssueNumber > 0 &&
		repositoryPattern.MatchString(request.Repository) &&
		repositoryPattern.MatchString(request.BlockerRepository) &&
		revisionPattern.MatchString(request.ExpectedGraphRevision)
}

func validCredential(token string) bool {
	if len(token) < 1 || len(token) > 4096 {
		return false
	}
	for _, char := range token {
		if char <= ' ' || char == '\x7f' {
			return false
		}
	}
	return true
}

func responseError(status int, body []byte) error {
	var response struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &response) == nil &&
		errorCodePattern.MatchString(response.Error.Code) &&
		strings.TrimSpace(response.Error.Message) == response.Error.Message &&
		response.Error.Message != "" && len(response.Error.Message) <= 1024 {
		return &APIError{
			Code:       response.Error.Code,
			Message:    response.Error.Message,
			StatusCode: status,
		}
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return ErrUnauthorized
	}
	if status >= http.StatusInternalServerError {
		return ErrUnavailable
	}
	return ErrInvalidResponse
}

func validateGraph(graph Graph, expectedRepository string) error {
	if !strings.EqualFold(graph.Repository, expectedRepository) ||
		!repositoryPattern.MatchString(graph.Repository) ||
		!revisionPattern.MatchString(graph.GraphRevision) ||
		(graph.DependencyFreshness != "current" && graph.DependencyFreshness != "stale") {
		return ErrInvalidResponse
	}
	issues := make(map[string]Issue, len(graph.Issues))
	for _, issue := range graph.Issues {
		key, ok := referenceKey(issue.NodeReference)
		if !ok || strings.TrimSpace(issue.Title) == "" {
			return ErrInvalidResponse
		}
		if _, exists := issues[key]; exists {
			return ErrInvalidResponse
		}
		issues[key] = issue
	}
	nodes := make(map[string]Node, len(graph.Nodes))
	for _, node := range graph.Nodes {
		key, ok := referenceKey(node.NodeReference)
		if !ok || node.Title == "" || !validNodeState(node.State) {
			return ErrInvalidResponse
		}
		issue, exists := issues[key]
		if !exists || issue.Title != node.Title || issue.Description != node.Description {
			return ErrInvalidResponse
		}
		if _, duplicate := nodes[key]; duplicate {
			return ErrInvalidResponse
		}
		nodes[key] = node
	}
	incoming := make(map[string]int, len(nodes))
	outgoing := make(map[string]int, len(nodes))
	edges := make(map[string]struct{}, len(graph.Edges))
	for _, edge := range graph.Edges {
		from, fromOK := referenceKey(edge.From)
		to, toOK := referenceKey(edge.To)
		if !fromOK || !toOK || from == to || nodes[from].Title == "" || nodes[to].Title == "" {
			return ErrInvalidResponse
		}
		key := from + ">" + to
		if _, exists := edges[key]; exists {
			return ErrInvalidResponse
		}
		if edge.Satisfied != (nodes[from].State == NodeDone) {
			return ErrInvalidResponse
		}
		edges[key] = struct{}{}
		incoming[to]++
		outgoing[from]++
	}
	if len(nodes) == 0 {
		if len(graph.Paths) != 0 {
			return ErrInvalidResponse
		}
		return nil
	}
	if len(graph.Paths) == 0 {
		return ErrInvalidResponse
	}
	seenNodes := make(map[string]struct{}, len(nodes))
	seenEdges := make(map[string]struct{}, len(edges))
	for _, path := range graph.Paths {
		if len(path) == 0 {
			return ErrInvalidResponse
		}
		keys := make([]string, len(path))
		for index, reference := range path {
			key, ok := referenceKey(reference)
			if !ok || nodes[key].Title == "" {
				return ErrInvalidResponse
			}
			keys[index] = key
			seenNodes[key] = struct{}{}
		}
		if incoming[keys[0]] != 0 || outgoing[keys[len(keys)-1]] != 0 {
			return ErrInvalidResponse
		}
		for index := 1; index < len(keys); index++ {
			edge := keys[index-1] + ">" + keys[index]
			if _, exists := edges[edge]; !exists {
				return ErrInvalidResponse
			}
			seenEdges[edge] = struct{}{}
		}
	}
	if len(seenNodes) != len(nodes) || len(seenEdges) != len(edges) {
		return ErrInvalidResponse
	}
	return nil
}

func validNodeState(state NodeState) bool {
	return state == NodeDone || state == NodeReady || state == NodeActive || state == NodeWait
}

func referenceKey(reference NodeReference) (string, bool) {
	if reference.Number < 1 || !repositoryPattern.MatchString(reference.Repository) {
		return "", false
	}
	return strings.ToLower(reference.Repository) + "#" + strconv.Itoa(reference.Number), true
}
