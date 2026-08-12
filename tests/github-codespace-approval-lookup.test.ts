import { describe, expect, mock, test } from 'bun:test';

import { createGitHubCodespaceApprovalLookup } from '../server/github-codespace-runner/approval-lookup';

describe('GitHub Codespace approval lookup', () => {
  test('finds the Linux connector by exact Codespace name without assuming its hostname', async () => {
    const query = mock(async () => ({
      rows: [{ id: '8ab9dfee-769e-4406-9804-2cb0e2ab6a91' }]
    }));
    const findApproval = createGitHubCodespaceApprovalLookup({
      database: async () => ({ query }),
      publicOrigin: () => 'https://projects.os-home.net'
    });

    await expect(findApproval({
      codespaceName: 'project-space--537-p56qw7vwpgc757q',
      createdAt: '2026-08-09T10:20:00.000Z'
    })).resolves.toEqual({
      approvalUrl: 'https://projects.os-home.net/machines/connect?request=8ab9dfee-769e-4406-9804-2cb0e2ab6a91'
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('where name = $1');
    expect(sql).toContain("operating_system = 'linux'");
    expect(sql).not.toContain('hostname = $1');
    expect(values).toEqual([
      'project-space--537-p56qw7vwpgc757q',
      '2026-08-09T10:20:00.000Z'
    ]);
  });

  test('does not expose a request without a configured public origin', async () => {
    const findApproval = createGitHubCodespaceApprovalLookup({
      database: async () => ({
        query: async () => ({ rows: [{ id: 'request-id' }] })
      }),
      publicOrigin: () => null
    });

    await expect(findApproval({
      codespaceName: 'project-space--537-p56qw7vwpgc757q',
      createdAt: '2026-08-09T10:20:00.000Z'
    })).resolves.toBeNull();
  });
});
