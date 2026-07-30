import type { ReleasePublication } from './types';

const repository = 'DotNaos/project-space';
const githubHeaders = {
  accept: 'application/vnd.github+json',
  'user-agent': 'project-space-docs',
  'x-github-api-version': '2022-11-28',
};

export async function loadGithubPublication(
  version: string,
): Promise<ReleasePublication> {
  const tag = `v${version}`;
  const [releaseResponse, latestResponse, refResponse] =
    await Promise.all([
      githubFetch(`/repos/${repository}/releases/tags/${tag}`),
      githubFetch(`/repos/${repository}/releases/latest`),
      githubFetch(`/repos/${repository}/git/ref/tags/${tag}`),
    ]);
  if (
    !releaseResponse.ok ||
    !latestResponse.ok ||
    !refResponse.ok
  ) {
    throw new Error(
      `GitHub does not expose complete publication metadata for ${tag}.`,
    );
  }

  const release: unknown = await releaseResponse.json();
  const latest: unknown = await latestResponse.json();
  const ref: unknown = await refResponse.json();
  if (!isRecord(release) || !isRecord(latest) || !isRecord(ref)) {
    throw new Error('GitHub returned invalid publication metadata.');
  }

  const commit = await resolveTagCommit(ref);
  const publishedAt = stringValue(release.published_at);
  const releaseTag = stringValue(release.tag_name);
  const htmlUrl = stringValue(release.html_url);
  if (
    releaseTag !== tag ||
    htmlUrl !==
      `https://github.com/${repository}/releases/tag/${tag}` ||
    !publishedAt ||
    release.draft !== false
  ) {
    throw new Error(
      `GitHub Release ${tag} is missing or not published.`,
    );
  }

  return {
    commit,
    githubReleaseUrl: htmlUrl,
    publishedAt,
    sourceRevision: commit,
    status:
      latest.tag_name === tag
        ? 'Latest'
        : release.prerelease === true
          ? 'Prerelease'
          : 'Published',
    tag,
    version,
  };
}

async function resolveTagCommit(ref: Record<string, unknown>) {
  const object = ref.object;
  if (!isRecord(object)) {
    throw new Error('GitHub tag reference has no target object.');
  }
  let type = stringValue(object.type);
  let sha = stringValue(object.sha)?.toLowerCase();
  for (let depth = 0; type === 'tag' && depth < 4; depth += 1) {
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error('GitHub annotated tag has an invalid target.');
    }
    const response = await githubFetch(
      `/repos/${repository}/git/tags/${sha}`,
    );
    if (!response.ok) {
      throw new Error('GitHub annotated tag target is unavailable.');
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.object)) {
      throw new Error('GitHub annotated tag target is invalid.');
    }
    type = stringValue(body.object.type);
    sha = stringValue(body.object.sha)?.toLowerCase();
  }
  if (type !== 'commit' || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('GitHub release tag does not resolve to a commit.');
  }
  return sha;
}

function githubFetch(path: string) {
  return fetch(`https://api.github.com${path}`, {
    headers: githubHeaders,
    next: { revalidate: 300 },
  });
}

function stringValue(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}
