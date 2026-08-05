export function issueBranchName(issueNumber: number, title: string) {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');

  return `issue-${issueNumber}${slug ? `-${slug}` : ''}`;
}
