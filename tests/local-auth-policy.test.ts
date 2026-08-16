import { describe, expect, test } from 'bun:test';

import { isProjectSpaceEmailAllowed } from '../server/local-auth-store';

describe('Project Space deployment membership policy', () => {
  test('fails closed in production when no deployment membership is configured', () => {
    expect(isProjectSpaceEmailAllowed('member@example.com', {
      PROJECT_DEPLOY_ENVIRONMENT: 'prod'
    })).toBe(false);
  });

  test('accepts only explicitly listed production members', () => {
    const environment = {
      PROJECT_DEPLOY_ENVIRONMENT: 'prod',
      PROJECT_SPACE_ALLOWED_EMAILS: 'member@example.com, teammate@example.com'
    };
    expect(isProjectSpaceEmailAllowed('MEMBER@example.com', environment)).toBe(true);
    expect(isProjectSpaceEmailAllowed('outsider@example.com', environment)).toBe(false);
    expect(isProjectSpaceEmailAllowed(undefined, environment)).toBe(false);
  });

  test('keeps an empty allowlist permissive outside production for local development', () => {
    expect(isProjectSpaceEmailAllowed('developer@example.com', {
      PROJECT_DEPLOY_ENVIRONMENT: 'preview'
    })).toBe(true);
  });
});
