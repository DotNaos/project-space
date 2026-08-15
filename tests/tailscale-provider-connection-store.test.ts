import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import {
  createProviderCredentialVault,
  ProviderCredentialVaultError
} from '../server/tailscale-provider-connection/credential-vault';
import { PostgresTailscaleProviderConnectionStore } from '../server/tailscale-provider-connection/store';

const ownerOne = 'owner-one';
const ownerTwo = 'owner-two';
const connectionId = '10000000-0000-4000-8000-000000000001';
const createdAt = '2026-08-14T09:00:00.000Z';
const verifiedAt = '2026-08-14T09:01:00.000Z';
const encryptionEnvironment = {
  PROJECT_SPACE_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
  PROJECT_SPACE_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_ID: 'provider-key-2026-08'
};

function vault(environment: NodeJS.ProcessEnv = encryptionEnvironment) {
  return createProviderCredentialVault(environment);
}

function activeRow(ownerUserId = ownerOne) {
  const envelope = vault().encrypt({ clientId: 'client-id-one', clientSecret: 'client-secret-one' });
  return {
    connection_id: connectionId,
    credential_ciphertext: envelope.ciphertext,
    credential_iv: envelope.iv,
    credential_key_id: envelope.keyId,
    credential_tag: envelope.tag,
    created_at: createdAt,
    owner_user_id: ownerUserId,
    revision: 1,
    revoked_at: null,
    state: 'active' as const,
    verified_at: verifiedAt
  };
}

class RecordingClient implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  constructor(private readonly row?: Record<string, unknown>) {}

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes('tailscale_provider_connections') && sql.includes('where owner_user_id')) {
      return { rows: values[0] === ownerOne && this.row ? [this.row as Row] : [] };
    }
    return { rows: [] as Row[] };
  }
}

describe('Tailscale provider connection credential vault', () => {
  test('requires one explicit canonical 32-byte key and key identifier', () => {
    for (const environment of [
      {},
      { ...encryptionEnvironment, PROJECT_SPACE_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_B64: 'not-base64' },
      { ...encryptionEnvironment, PROJECT_SPACE_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_B64: Buffer.alloc(31).toString('base64') },
      { ...encryptionEnvironment, PROJECT_SPACE_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_ID: '' }
    ]) {
      expect(() => createProviderCredentialVault(environment)).toThrow(ProviderCredentialVaultError);
    }
  });

  test('round-trips credentials but fails closed for a wrong key or tampered envelope', () => {
    const encrypted = vault().encrypt({ clientId: 'client-id-one', clientSecret: 'client-secret-one' });
    expect(vault().decrypt(encrypted)).toEqual({ clientId: 'client-id-one', clientSecret: 'client-secret-one' });
    expect(() => createProviderCredentialVault({
      ...encryptionEnvironment,
      PROJECT_SPACE_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_B64: Buffer.alloc(32, 8).toString('base64')
    }).decrypt(encrypted)).toThrow(ProviderCredentialVaultError);
    expect(() => vault().decrypt({ ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -4)}AAAA` }))
      .toThrow(ProviderCredentialVaultError);
  });
});

describe('Tailscale provider connection store', () => {
  test('scopes status and active credential reads to their exact owner', async () => {
    const client = new RecordingClient(activeRow());
    const store = new PostgresTailscaleProviderConnectionStore(client, vault(), () => connectionId);

    await expect(store.readStatus(ownerOne)).resolves.toMatchObject({
      connectionId, ownerUserId: ownerOne, state: 'active'
    });
    await expect(store.readActive(ownerOne)).resolves.toEqual({
      credentials: { clientId: 'client-id-one', clientSecret: 'client-secret-one' },
      status: expect.objectContaining({ connectionId, ownerUserId: ownerOne, state: 'active' })
    });
    await expect(store.readStatus(ownerTwo)).resolves.toBeNull();
    await expect(store.readActive(ownerTwo)).resolves.toBeNull();

    for (const call of client.calls) {
      expect(call.sql).toContain('where owner_user_id = $1');
      expect(call.values[0]).toMatch(/^owner-(one|two)$/);
    }
  });

  test('encrypts credentials before an owner-scoped save and records a safe audit', async () => {
    const saved = activeRow();
    const client: DatabaseQueryClient & { calls: Array<{ sql: string; values: readonly unknown[] }> } = {
      calls: [],
      async query<Row>(sql, values: readonly unknown[] = []) {
        this.calls.push({ sql, values });
        if (sql.startsWith('insert into tailscale_provider_connections')) return { rows: [saved as Row] };
        return { rows: [] as Row[] };
      }
    };
    const store = new PostgresTailscaleProviderConnectionStore(client, vault(), () => connectionId);
    const status = await store.saveVerified({
      actorId: 'actor-one',
      credentials: { clientId: 'client-id-one', clientSecret: 'client-secret-one' },
      ownerUserId: ownerOne,
      verifiedAt
    });

    expect(status).toEqual(expect.objectContaining({ connectionId, ownerUserId: ownerOne, revision: 1 }));
    expect(JSON.stringify(status)).not.toMatch(/client-id-one|client-secret-one|ciphertext|credential/i);
    const save = client.calls[0];
    expect(save?.sql).toContain('on conflict (owner_user_id) do update');
    expect(save?.values[1]).toBe(ownerOne);
    expect(JSON.stringify(save?.values)).not.toContain('client-id-one');
    expect(JSON.stringify(save?.values)).not.toContain('client-secret-one');
    const audit = client.calls[1];
    expect(audit?.sql).toContain('tailscale_provider_connection_audits');
    expect(audit?.values).toEqual([connectionId, ownerOne, 'actor-one', 1]);
  });

  test('denies cross-owner revocation and clears encrypted material before returning revoked status', async () => {
    const revoked = { ...activeRow(), credential_ciphertext: null, credential_iv: null,
      credential_key_id: null, credential_tag: null, revision: 2,
      revoked_at: '2026-08-14T09:02:00.000Z', state: 'revoked' as const };
    const client: DatabaseQueryClient & { calls: Array<{ sql: string; values: readonly unknown[] }> } = {
      calls: [],
      async query<Row>(sql, values: readonly unknown[] = []) {
        this.calls.push({ sql, values });
        if (sql.startsWith('update tailscale_provider_connections')) {
          return { rows: values[0] === ownerOne ? [revoked as Row] : [] };
        }
        return { rows: [] as Row[] };
      }
    };
    const store = new PostgresTailscaleProviderConnectionStore(client, vault(), () => connectionId);

    await expect(store.revoke({ actorId: 'actor-two', ownerUserId: ownerTwo })).resolves.toBeNull();
    const status = await store.revoke({ actorId: 'actor-one', ownerUserId: ownerOne });
    expect(status).toEqual(expect.objectContaining({ state: 'revoked', revokedAt: '2026-08-14T09:02:00.000Z' }));
    expect(JSON.stringify(status)).not.toMatch(/credential|ciphertext|client-secret/i);
    const updates = client.calls.filter(({ sql }) => sql.startsWith('update tailscale_provider_connections'));
    for (const update of updates) {
      expect(update.sql).toContain('credential_key_id = null, credential_ciphertext = null');
      expect(update.sql).toContain('where owner_user_id = $1 and state = \'active\'');
    }
    const audit = client.calls.at(-1);
    expect(audit?.values).toEqual([connectionId, ownerOne, 'actor-one', 2]);
  });
});
