import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

describe('release signing boundary', () => {
  test('provisions a non-interactive protected environment', () => {
    const environment = JSON.parse(read('.github/environments/release-signing.json'));

    expect(environment.reviewers).toEqual([]);
    expect(environment.wait_timer).toBe(0);
    expect(environment.prevent_self_review).toBe(false);
    expect(environment.deployment_branch_policy).toEqual({
      protected_branches: true,
      custom_branch_policies: false,
    });
  });

  test('keeps signing isolated from pull-request execution', () => {
    const signer = read('.github/workflows/release-manifest-sign.yml');

    expect(signer).toContain('on:\n  workflow_call:');
    expect(signer).not.toMatch(/^\s+pull_request:/m);
    expect(signer).toContain('    environment: release-signing');
    expect(signer).toContain('id-token: write');
    expect(signer).toContain('project-slug: project-space-release-signing');
    expect(signer).toContain('env-slug: prod');
    expect(signer).toContain('PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64');
    expect(signer).not.toContain('OP_SERVICE_ACCOUNT_TOKEN');
    expect(signer).not.toContain('op://');
    expect(signer).toContain('Validate immutable release provenance');
    expect(signer).toContain('Validate immutable artifact metadata');
  });
});
