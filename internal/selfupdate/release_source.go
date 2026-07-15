package selfupdate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	githubLatestReleaseURL    = "https://api.github.com/repos/DotNaos/project-space/releases/latest"
	githubReleaseDownloadRoot = "https://github.com/DotNaos/project-space/releases/download"
	releaseRequestTimeout     = 15 * time.Second
	releaseMetadataMaxBytes   = 1 << 20
)

type GitHubReleaseResolverOptions struct {
	HTTPClient *http.Client
	Now        func() time.Time
}

type githubReleaseResolver struct {
	client    *http.Client
	now       func() time.Time
	publicKey []byte
}

// NewGitHubReleaseResolver resolves only signed manifests attached to the
// exact semantic-version tag discovered by GitHub's latest-release endpoint.
func NewGitHubReleaseResolver(options GitHubReleaseResolverOptions) ReleaseResolver {
	return newGitHubReleaseResolver(options, embeddedReleaseManifestPublicKey)
}

func newGitHubReleaseResolver(options GitHubReleaseResolverOptions, publicKey []byte) ReleaseResolver {
	client := http.Client{}
	if options.HTTPClient != nil {
		client = *options.HTTPClient
	}
	client.Timeout = releaseRequestTimeout
	client.CheckRedirect = safeGitHubRedirect
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &githubReleaseResolver{client: &client, now: now, publicKey: append([]byte(nil), publicKey...)}
}

func (resolver *githubReleaseResolver) Resolve(ctx context.Context, target string) (Release, error) {
	if !supportedReleaseTarget(target) {
		return Release{}, fmt.Errorf("self-update target %q is unsupported", target)
	}
	metadata, err := resolver.get(ctx, githubLatestReleaseURL, releaseMetadataMaxBytes, "GitHub release metadata")
	if err != nil {
		return Release{}, err
	}
	tag, err := parseLatestReleaseTag(metadata)
	if err != nil {
		return Release{}, err
	}
	manifestURL := fmt.Sprintf("%s/%s/%s", githubReleaseDownloadRoot, tag, releaseManifestAssetName)
	body, err := resolver.get(ctx, manifestURL, releaseManifestMaximumBytes, "signed release manifest")
	if err != nil {
		return Release{}, err
	}
	release, err := verifySignedReleaseManifest(body, tag, target, resolver.now().UTC(), resolver.publicKey)
	if err != nil {
		return Release{}, fmt.Errorf("verify signed release manifest: %w", err)
	}
	return release, nil
}

func (resolver *githubReleaseResolver) get(ctx context.Context, address string, maximum int64, description string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, fmt.Errorf("create %s request: %w", description, err)
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "project-space-self-update")
	response, err := resolver.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", description, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("download %s: GitHub returned HTTP %d", description, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maximum+1))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", description, err)
	}
	if int64(len(body)) > maximum {
		return nil, fmt.Errorf("read %s: response exceeds %d bytes", description, maximum)
	}
	return body, nil
}

func parseLatestReleaseTag(body []byte) (string, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return "", errors.New("GitHub latest release metadata is empty")
	}
	if err := rejectDuplicateJSONKeys(body); err != nil {
		return "", fmt.Errorf("GitHub latest release metadata is invalid: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", errors.New("GitHub latest release metadata is invalid")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return "", errors.New("GitHub latest release metadata must contain one JSON value")
	}
	object, ok := value.(map[string]any)
	if !ok {
		return "", errors.New("GitHub latest release metadata must be an object")
	}
	tag, ok := object["tag_name"].(string)
	if !ok || !releaseIDPattern.MatchString(tag) {
		return "", errors.New("GitHub latest release tag is not an exact vSemver tag")
	}
	return tag, nil
}

func safeGitHubRedirect(request *http.Request, via []*http.Request) error {
	if len(via) > 3 {
		return errors.New("GitHub redirect limit exceeded")
	}
	parsed := request.URL
	if parsed.Scheme != "https" || parsed.User != nil || parsed.Fragment != "" || !safeGitHubHost(parsed.Hostname()) {
		return errors.New("GitHub redirected the release request to an unsafe URL")
	}
	if request.Method != http.MethodGet {
		return errors.New("GitHub redirected the release request with an unsafe method")
	}
	return nil
}

func safeGitHubHost(host string) bool {
	switch strings.ToLower(host) {
	case "api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com":
		return true
	default:
		return false
	}
}

func supportedReleaseTarget(target string) bool {
	switch target {
	case "darwin-arm64", "linux-x64", "windows-x64":
		return true
	default:
		return false
	}
}
