import type { DatabaseQueryClient } from '../database/client';

export interface GitHubCodespaceApprovalLookupDependencies {
  database(): Promise<Pick<DatabaseQueryClient, 'query'>>;
  publicOrigin(): string | null;
}

export function createGitHubCodespaceApprovalLookup(
  dependencies: GitHubCodespaceApprovalLookupDependencies
) {
  return async (input: { codespaceName: string; createdAt: string }) => {
    const client = await dependencies.database();
    const found = await client.query<{ id: string }>(
      `select id
         from machine_connection_requests
        where name = $1
          and operating_system = 'linux'
          and created_at >= $2::timestamptz - interval '5 minutes'
          and expires_at > now() and status in ('pending', 'approved')
        order by created_at desc
        limit 1`,
      [input.codespaceName, input.createdAt]
    );
    const id = found.rows[0]?.id;
    const origin = dependencies.publicOrigin();
    return id && origin
      ? { approvalUrl: `${origin}/machines/connect?request=${encodeURIComponent(id)}` }
      : null;
  };
}
