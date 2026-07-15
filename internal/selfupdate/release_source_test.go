package selfupdate

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type releaseRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip releaseRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestGitHubReleaseResolverUsesLatestOnlyForExactTagDiscovery(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	manifest, publicKey := manifestTestEnvelope(t, now, nil)
	var requests []string
	client := &http.Client{Transport: releaseRoundTripper(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.URL.String())
		var body []byte
		switch request.URL.String() {
		case githubLatestReleaseURL:
			body = []byte(`{"tag_name":"v1.2.3","name":"Project Space"}`)
		case githubReleaseDownloadRoot + "/v1.2.3/" + releaseManifestAssetName:
			body = manifest
		default:
			t.Fatalf("unexpected release request: %s", request.URL)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header), Request: request}, nil
	})}
	resolver := newGitHubReleaseResolver(GitHubReleaseResolverOptions{HTTPClient: client, Now: func() time.Time { return now }}, publicKey)
	release, err := resolver.Resolve(context.Background(), "linux-x64")
	if err != nil {
		t.Fatal(err)
	}
	if release.Manifest.Version != manifestTestVersion || len(requests) != 2 {
		t.Fatalf("unexpected resolution result: %#v, requests=%v", release, requests)
	}
	if strings.Contains(requests[1], "/latest/download/") {
		t.Fatalf("resolver used a mutable latest asset URL: %s", requests[1])
	}
}

func TestGitHubReleaseResolverRejectsUnsafeLatestMetadata(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"not semver": `{"tag_name":"latest"}`,
		"missing v":  `{"tag_name":"1.2.3"}`,
		"duplicate":  `{"tag_name":"v1.2.3","tag_name":"v1.2.4"}`,
		"trailing":   `{"tag_name":"v1.2.3"}{}`,
	}
	for name, metadata := range cases {
		metadata := metadata
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			client := &http.Client{Transport: releaseRoundTripper(func(request *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(metadata)), Header: make(http.Header), Request: request}, nil
			})}
			resolver := NewGitHubReleaseResolver(GitHubReleaseResolverOptions{HTTPClient: client})
			if _, err := resolver.Resolve(context.Background(), "linux-x64"); err == nil {
				t.Fatal("expected unsafe latest metadata to be rejected")
			}
		})
	}
}

func TestGitHubReleaseResolverBoundsResponsesAndTargets(t *testing.T) {
	t.Parallel()
	requestCount := 0
	client := &http.Client{Transport: releaseRoundTripper(func(request *http.Request) (*http.Response, error) {
		requestCount++
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(strings.Repeat("x", releaseMetadataMaxBytes+1))),
			Header:     make(http.Header),
			Request:    request,
		}, nil
	})}
	resolver := NewGitHubReleaseResolver(GitHubReleaseResolverOptions{HTTPClient: client})
	if _, err := resolver.Resolve(context.Background(), "plan9-x64"); err == nil || requestCount != 0 {
		t.Fatalf("unsupported target should fail before network access: err=%v requests=%d", err, requestCount)
	}
	if _, err := resolver.Resolve(context.Background(), "linux-x64"); err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected oversized response rejection, got %v", err)
	}
	concrete := resolver.(*githubReleaseResolver)
	if concrete.client.Timeout != releaseRequestTimeout {
		t.Fatalf("resolver timeout = %s, want %s", concrete.client.Timeout, releaseRequestTimeout)
	}
}

func TestSafeGitHubRedirect(t *testing.T) {
	t.Parallel()
	previous, _ := http.NewRequest(http.MethodGet, githubLatestReleaseURL, nil)
	for _, address := range []string{
		"https://github.com/DotNaos/project-space/releases/download/v1.2.3/project-space-release-manifest.json",
		"https://release-assets.githubusercontent.com/example?token=opaque",
	} {
		request, _ := http.NewRequest(http.MethodGet, address, nil)
		if err := safeGitHubRedirect(request, []*http.Request{previous}); err != nil {
			t.Fatalf("safe redirect %s rejected: %v", address, err)
		}
	}
	for _, address := range []string{
		"http://github.com/DotNaos/project-space/releases/download/v1.2.3/project-space-release-manifest.json",
		"https://example.com/manifest.json",
	} {
		request, _ := http.NewRequest(http.MethodGet, address, nil)
		if err := safeGitHubRedirect(request, []*http.Request{previous}); err == nil {
			t.Fatalf("unsafe redirect %s was accepted", address)
		}
	}
}
