export async function requestGitHubGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const response = await fetch('https://api.github.com/graphql', {
    body: JSON.stringify({ query, variables }),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    method: 'POST'
  });
  const payload = (await response.json().catch(() => undefined)) as
    | { data?: T; errors?: Array<{ message?: string }> }
    | undefined;

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with ${response.status}.`);
  }

  if (payload?.errors?.length) {
    throw new Error(
      payload.errors.map((error) => error.message).filter(Boolean).join(' ') ||
        'GitHub GraphQL request failed.'
    );
  }

  if (!payload?.data) {
    throw new Error('GitHub GraphQL response did not include data.');
  }

  return payload.data;
}
