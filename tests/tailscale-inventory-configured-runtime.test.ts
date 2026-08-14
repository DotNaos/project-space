import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';

import { isConfiguredInventoryOwner } from '../server/tailscale-inventory/configured-runtime';

describe('configured Tailscale inventory ownership', () => {
  test('uses the configured Clerk subject hash without exposing the subject', () => {
    const ownerUserId = 'user_owner';
    const environment = {
      PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_EMAIL: 'other@example.com',
      PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_SUBJECT_SHA256: createHash('sha256')
        .update(ownerUserId)
        .digest('hex')
    };
    expect(
      isConfiguredInventoryOwner(
        { email: 'owner@example.com', userId: ownerUserId },
        environment
      )
    ).toBe(true);
    expect(
      isConfiguredInventoryOwner(
        { email: 'owner@example.com', userId: 'user_other' },
        environment
      )
    ).toBe(false);
    expect(
      isConfiguredInventoryOwner(
        { email: 'owner@example.com', userId: ownerUserId },
        { PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_SUBJECT_SHA256: 'invalid' }
      )
    ).toBe(false);
  });

  test('requires a valid subject hash in production instead of falling back', () => {
    const identity = { email: 'owner@example.com', userId: 'user_owner' };
    for (const configured of [undefined, '', '   ', 'invalid']) {
      expect(isConfiguredInventoryOwner(identity, {
        PROJECT_DEPLOY_ENVIRONMENT: 'prod',
        PROJECT_SPACE_ALLOWED_EMAILS: 'owner@example.com',
        PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_EMAIL: 'owner@example.com',
        ...(configured === undefined ? {} : {
          PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_SUBJECT_SHA256: configured
        })
      })).toBe(false);
    }
  });

  test('uses a dedicated owner when configured', () => {
    const environment = {
      PROJECT_SPACE_ALLOWED_EMAILS: 'other@example.com',
      PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_EMAIL: 'Owner@Example.com'
    };
    expect(
      isConfiguredInventoryOwner(
        { email: 'owner@example.com', userId: 'owner' },
        environment
      )
    ).toBe(true);
    expect(
      isConfiguredInventoryOwner(
        { email: 'other@example.com', userId: 'other' },
        environment
      )
    ).toBe(false);
  });

  test('fails closed unless the normal allowlist names exactly one owner', () => {
    expect(isConfiguredInventoryOwner({ email: 'owner@example.com', userId: 'owner' }, {})).toBe(false);
    expect(isConfiguredInventoryOwner({ email: 'owner@example.com', userId: 'owner' }, {
      PROJECT_SPACE_ALLOWED_EMAILS: 'owner@example.com,other@example.com'
    })).toBe(false);
    expect(isConfiguredInventoryOwner({ email: 'OWNER@example.com', userId: 'owner' }, {
      PROJECT_SPACE_ALLOWED_EMAILS: 'owner@example.com'
    })).toBe(true);
  });
});
