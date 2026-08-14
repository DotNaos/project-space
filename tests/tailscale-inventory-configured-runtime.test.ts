import { describe, expect, test } from 'bun:test';

import { isConfiguredInventoryOwner } from '../server/tailscale-inventory/configured-runtime';

describe('configured Tailscale inventory ownership', () => {
  test('uses a dedicated owner when configured', () => {
    const environment = {
      PROJECT_SPACE_ALLOWED_EMAILS: 'other@example.com',
      PROJECT_SPACE_TAILSCALE_INVENTORY_OWNER_EMAIL: 'Owner@Example.com'
    };
    expect(isConfiguredInventoryOwner('owner@example.com', environment)).toBe(true);
    expect(isConfiguredInventoryOwner('other@example.com', environment)).toBe(false);
  });

  test('fails closed unless the normal allowlist names exactly one owner', () => {
    expect(isConfiguredInventoryOwner('owner@example.com', {})).toBe(false);
    expect(isConfiguredInventoryOwner('owner@example.com', {
      PROJECT_SPACE_ALLOWED_EMAILS: 'owner@example.com,other@example.com'
    })).toBe(false);
    expect(isConfiguredInventoryOwner('OWNER@example.com', {
      PROJECT_SPACE_ALLOWED_EMAILS: 'owner@example.com'
    })).toBe(true);
  });
});
