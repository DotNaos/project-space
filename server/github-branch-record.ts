import type { GitHubBranchRecord } from '../src/shared/project-space-api';

function branchWebUrl(repositoryUrl: string, branchName: string) {
  return `${repositoryUrl}/tree/${encodeURIComponent(branchName).replace(/%2F/g, '/')}`;
}

export function pullRequestHeadBranchRecord(input: {
  branchName: string;
  commitSha: string;
  current?: GitHubBranchRecord;
  linkedIssueNumbers: number[];
  repositoryUrl: string;
}): GitHubBranchRecord {
  return {
    ...input.current,
    commitSha: input.commitSha,
    isDefault: input.current?.isDefault ?? false,
    linkedIssueNumbers: Array.from(new Set([
      ...(input.current?.linkedIssueNumbers ?? []),
      ...input.linkedIssueNumbers
    ])).sort((left, right) => left - right),
    name: input.branchName,
    url: input.current?.url ?? branchWebUrl(input.repositoryUrl, input.branchName)
  };
}
