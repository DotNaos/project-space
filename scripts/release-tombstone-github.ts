import { createHash } from 'node:crypto';
import {
  validateReleaseTombstoneProof,
  type TombstoneWorkflowJob,
  type TombstoneWorkflowRun,
  type UnpublishedReleaseTombstone,
} from './release-tombstone';

export type TombstoneGitHubFetch = (path: string) => Promise<Response>;

export async function verifyReleaseTombstoneFromGitHub(
  tombstone: UnpublishedReleaseTombstone,
  githubFetch: TombstoneGitHubFetch,
) {
  const [exhausted, verification, releaseState, tagCommit] = await Promise.all([
    workflowRunEvidence(tombstone.exhaustedRunId, githubFetch),
    workflowRunEvidence(tombstone.verificationRunId, githubFetch),
    githubReleaseState(tombstone.tag, githubFetch),
    githubTagCommit(tombstone.tag, githubFetch),
  ]);
  validateReleaseTombstoneProof({
    exhaustedJobs: exhausted.jobs,
    exhaustedRun: exhausted.run,
    releaseState,
    tagCommit,
    tombstone,
    verificationJobs: verification.jobs,
    verificationRun: verification.run,
  });
}

async function workflowRunEvidence(
  id: number,
  githubFetch: TombstoneGitHubFetch,
): Promise<{ jobs: TombstoneWorkflowJob[]; run: TombstoneWorkflowRun }> {
  const [runResponse, jobsResponse] = await Promise.all([
    githubFetch(`/actions/runs/${id}`),
    githubFetch(`/actions/runs/${id}/jobs?per_page=100`),
  ]);
  if (!runResponse.ok || !jobsResponse.ok) {
    throw new Error(`Could not load release tombstone workflow run ${id}.`);
  }
  const runBody: unknown = await runResponse.json();
  const jobsBody: unknown = await jobsResponse.json();
  if (
    !isRecord(runBody) || runBody.id !== id ||
    typeof runBody.display_title !== 'string' ||
    typeof runBody.event !== 'string' || typeof runBody.head_branch !== 'string' ||
    typeof runBody.head_sha !== 'string' ||
    typeof runBody.path !== 'string' ||
    typeof runBody.status !== 'string' ||
    !(typeof runBody.conclusion === 'string' || runBody.conclusion === null) ||
    typeof runBody.run_attempt !== 'number' ||
    !isRecord(jobsBody) || typeof jobsBody.total_count !== 'number' ||
    !Number.isSafeInteger(jobsBody.total_count) || jobsBody.total_count > 100 ||
    !Array.isArray(jobsBody.jobs) || jobsBody.jobs.length !== jobsBody.total_count
  ) {
    throw new Error(`GitHub returned invalid tombstone evidence for run ${id}.`);
  }
  const jobs = jobsBody.jobs.map((value): TombstoneWorkflowJob => {
    if (
      !isRecord(value) || typeof value.name !== 'string' ||
      typeof value.status !== 'string' ||
      !(typeof value.conclusion === 'string' || value.conclusion === null)
    ) throw new Error(`GitHub returned an invalid job for tombstone run ${id}.`);
    return {
      conclusion: value.conclusion,
      name: value.name,
      status: value.status,
    };
  });
  const headSha = requiredCommit(runBody.head_sha, `${id} workflow head`);
  return {
    jobs,
    run: {
      conclusion: runBody.conclusion,
      displayTitle: runBody.display_title,
      event: runBody.event,
      headBranch: runBody.head_branch,
      headSha,
      id,
      runAttempt: runBody.run_attempt,
      status: runBody.status,
      workflowPath: runBody.path,
      workflowSha256: await workflowDigest(headSha, githubFetch),
    },
  };
}

async function workflowDigest(
  commit: string,
  githubFetch: TombstoneGitHubFetch,
) {
  const response = await githubFetch(
    `/contents/.github/workflows/release.yml?ref=${commit}`,
  );
  if (!response.ok) {
    throw new Error(`Could not load release workflow at ${commit}.`);
  }
  const body: unknown = await response.json();
  if (
    !isRecord(body) || body.encoding !== 'base64' ||
    typeof body.content !== 'string' || body.content.length > 512 * 1024
  ) {
    throw new Error(`GitHub returned invalid release workflow at ${commit}.`);
  }
  const encoded = body.content.replaceAll('\n', '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error(`GitHub returned invalid release workflow at ${commit}.`);
  }
  let source: Buffer;
  try {
    source = Buffer.from(encoded, 'base64');
  } catch {
    throw new Error(`GitHub returned invalid release workflow at ${commit}.`);
  }
  if (
    source.length === 0 || source.length > 256 * 1024 ||
    source.toString('base64') !== encoded
  ) {
    throw new Error(`GitHub returned invalid release workflow at ${commit}.`);
  }
  return createHash('sha256').update(source).digest('hex');
}

async function githubReleaseState(
  tag: string,
  githubFetch: TombstoneGitHubFetch,
) {
  const response = await githubFetch(
    `/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (response.status === 404) return 'missing' as const;
  if (!response.ok) throw new Error(`Could not inspect GitHub Release ${tag}.`);
  const body: unknown = await response.json();
  if (!isRecord(body) || body.tag_name !== tag || typeof body.draft !== 'boolean') {
    throw new Error(`GitHub returned invalid publication data for ${tag}.`);
  }
  if (body.draft) return 'draft' as const;
  if (typeof body.published_at !== 'string' || !body.published_at.trim()) {
    throw new Error(`GitHub Release ${tag} has no publication proof.`);
  }
  return 'published' as const;
}

async function githubTagCommit(
  tag: string,
  githubFetch: TombstoneGitHubFetch,
) {
  const response = await githubFetch(`/git/ref/tags/${tag}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Could not verify tag ${tag}.`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.object) || typeof body.object.sha !== 'string') {
    throw new Error(`GitHub returned an invalid target for ${tag}.`);
  }
  if (body.object.type === 'commit') {
    return requiredCommit(body.object.sha, `${tag} target`);
  }
  if (body.object.type !== 'tag') throw new Error(`${tag} is not a Git commit tag.`);
  const annotated = await githubFetch(`/git/tags/${body.object.sha}`);
  if (!annotated.ok) throw new Error(`Could not resolve annotated tag ${tag}.`);
  const tagBody: unknown = await annotated.json();
  if (
    !isRecord(tagBody) || !isRecord(tagBody.object) ||
    tagBody.object.type !== 'commit' || typeof tagBody.object.sha !== 'string'
  ) throw new Error(`${tag} does not resolve directly to a Git commit.`);
  return requiredCommit(tagBody.object.sha, `${tag} target`);
}

function requiredCommit(value: string, label: string) {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a full lowercase Git commit SHA.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
import { createHash } from 'node:crypto';
