import { describe, expect, test } from 'bun:test';

import type {
  AccessRouteAuthorization,
  PrivateNetworkInventory
} from '../server/private-network/contracts';
import type {
  SshControlTransport,
  SshGatewayActor,
  SshGatewayRequest
} from '../server/ssh-control-gateway/contracts';
import { MemorySshGatewayOperationStore } from '../server/ssh-control-gateway/memory-store';
import { SshControlGatewayService } from '../server/ssh-control-gateway/service';

const owner = 'user-1';
const environmentId = '11111111-1111-4111-8111-111111111111';
const routeId = '22222222-2222-4222-8222-222222222222';
const networkId = '33333333-3333-4333-8333-333333333333';
const revision = '1:environment:test';
const actor: SshGatewayActor = { id: 'actor-1', kind: 'machine', ownerUserId: owner };
const request: SshGatewayRequest = {
  environmentId,
  operation: 'status.v1',
  operationId: 'operation-1'
};

describe('SSH control gateway service', () => {
  test('runs harmless typed status once and replays it without Connector or SSH', async () => {
    const calls: string[] = [];
    const transport = successfulTransport(calls);
    const service = gateway({ calls, transport });

    const first = await service.execute(actor, request);
    const replay = await service.execute(actor, request);

    expect(first.result.state).toBe('ready');
    expect(replay.replayed).toBe(true);
    expect(calls).toEqual([
      'authorize:route_resolution', 'target', 'routes', 'authorize:execution', 'target', 'routes',
      'verify-host', 'credential', 'ssh-handshake',
      'authorize:execution', 'target', 'routes', 'ssh',
      'authorize:route_resolution', 'target', 'routes'
    ]);
    const evidence = JSON.stringify(first);
    for (const forbidden of [
      '100.64.0.10', 'ssh-user', 'op://', 'PRIVATE KEY', 'SHA256:'
    ]) expect(evidence).not.toContain(forbidden);
  });

  test('denied first authorization does not load routes, credentials, or network', async () => {
    const calls: string[] = [];
    const service = gateway({
      calls,
      authorize: () => ({ ...authorization(), allowed: false }),
      transport: successfulTransport(calls)
    });
    await expect(service.execute(actor, request)).rejects.toMatchObject({
      code: 'authorization_denied'
    });
    expect(calls).toEqual(['authorize:route_resolution']);
  });

  test('authorization drift fails before host or credential access', async () => {
    const calls: string[] = [];
    let count = 0;
    const service = gateway({
      calls,
      authorize: () => ({ ...authorization(), gatewayId: ++count === 1 ? 'gateway-1' : 'gateway-2' }),
      transport: successfulTransport(calls)
    });
    await expect(service.execute(actor, request)).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(calls).toEqual([
      'authorize:route_resolution', 'target', 'routes', 'authorize:execution', 'target', 'routes'
    ]);
  });

  test('timeout becomes uncertain and exact retry never dispatches again', async () => {
    const calls: string[] = [];
    const transport = successfulTransport(calls);
    transport.execute = async () => {
      calls.push('ssh');
      return { exitCode: null, stderr: '', stdout: '', timedOut: true };
    };
    const service = gateway({ calls, transport });
    await expect(service.execute(actor, request)).rejects.toMatchObject({ code: 'timeout' });
    await expect(service.execute(actor, request)).rejects.toMatchObject({ code: 'operation_conflict' });
    expect(calls.filter((call) => call === 'ssh')).toHaveLength(1);
  });

  test('same operation ID with changed actor is rejected as a replay conflict', async () => {
    const calls: string[] = [];
    const service = gateway({ calls, transport: successfulTransport(calls) });
    await service.execute(actor, request);
    await expect(service.execute({ ...actor, id: 'actor-2' }, request))
      .rejects.toMatchObject({ code: 'operation_conflict' });
  });

  test('stale route fails before host verification or credential access', async () => {
    const calls: string[] = [];
    const current = inventory();
    const stale = {
      ...current,
      routes: current.routes.map((route) => ({
        ...route,
        lastVerifiedAt: new Date(Date.now() - 600_000).toISOString(),
        verifiedUntil: new Date(Date.now() - 300_000).toISOString()
      }))
    };
    const service = gateway({
      calls,
      inventory: () => stale,
      transport: successfulTransport(calls)
    });
    await expect(service.execute(actor, request)).rejects.toMatchObject({ code: 'route_unavailable' });
    expect(calls).toEqual(['authorize:route_resolution', 'target', 'routes']);
  });

  test('incompatible CLI response is fenced and never dispatched twice', async () => {
    const calls: string[] = [];
    const transport = successfulTransport(calls);
    transport.handshake = async () => {
      calls.push('ssh-handshake');
      return { exitCode: 0, stderr: '', stdout: '{}', timedOut: false };
    };
    const service = gateway({ calls, transport });
    await expect(service.execute(actor, request)).rejects.toMatchObject({ code: 'cli_incompatible' });
    await expect(service.execute(actor, request)).rejects.toMatchObject({ code: 'operation_conflict' });
    expect(calls.filter((call) => call === 'ssh-handshake')).toHaveLength(1);
    expect(calls).not.toContain('ssh');
  });

  test('authorization that expires during the handshake cannot dispatch the operation', async () => {
    const calls: string[] = [];
    let authorizations = 0;
    const service = gateway({
      calls,
      authorize: () => ({
        ...authorization(),
        expiresAt: new Date(Date.now() + (++authorizations === 3 ? 1_000 : 60_000)).toISOString()
      }),
      transport: successfulTransport(calls)
    });

    await expect(service.execute(actor, request)).rejects.toMatchObject({
      code: 'authorization_denied'
    });
    expect(calls).toContain('ssh-handshake');
    expect(calls).not.toContain('ssh');
  });

  test('route evidence that expires during preflight cannot dispatch the operation', async () => {
    const calls: string[] = [];
    let loads = 0;
    const service = gateway({
      calls,
      inventory: () => {
        const value = inventory();
        loads += 1;
        if (loads < 3) return value;
        return {
          ...value,
          routes: value.routes.map((route) => ({
            ...route,
            lastVerifiedAt: new Date(Date.now() - 120_000).toISOString(),
            verifiedUntil: new Date(Date.now() - 1).toISOString()
          }))
        };
      },
      transport: successfulTransport(calls)
    });
    await expect(service.execute(actor, request)).rejects.toMatchObject({ code: 'route_unavailable' });
    expect(calls).toContain('ssh-handshake');
    expect(calls).not.toContain('ssh');
  });
});

function gateway(input: {
  authorize?: () => AccessRouteAuthorization;
  calls: string[];
  inventory?: () => PrivateNetworkInventory;
  transport: SshControlTransport;
}) {
  return new SshControlGatewayService({
    authorization: {
      authorize: async ({ phase }) => {
        input.calls.push(`authorize:${phase}`);
        return input.authorize?.() ?? authorization();
      }
    },
    credentials: {
      resolve: async () => {
        input.calls.push('credential');
        return {
          privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----',
          purpose: 'project_control_gateway_v1'
        };
      }
    },
    operations: new MemorySshGatewayOperationStore(),
    routes: {
      load: async () => {
        input.calls.push('routes');
        return input.inventory?.() ?? inventory();
      }
    },
    targets: {
      resolve: async () => {
        input.calls.push('target');
        return {
          environmentDefinitionId: 'definition-1', environmentId,
          platformId: 'platform-1', targetIdentityRevision: revision
        };
      }
    },
    transport: input.transport
  });
}

function authorization(): AccessRouteAuthorization {
  return {
    allowed: true,
    capability: 'project_cli',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    gatewayId: 'gateway-1',
    ownerUserId: owner,
    risk: 'normal',
    target: { id: environmentId, identityRevision: revision, kind: 'environment' }
  };
}

function inventory(): PrivateNetworkInventory {
  const lastVerifiedAt = new Date(Date.now() - 1_000).toISOString();
  const verifiedUntil = new Date(Date.now() + 60_000).toISOString();
  return {
    networks: [{
      approvalState: 'approved', availability: 'available', enabled: true,
      id: networkId, lastVerifiedAt, name: 'private', ownerUserId: owner,
      providerKind: 'tailscale', providerReference: 'provider-ref', verifiedUntil
    }],
    routes: [{
      allowedGatewayIds: ['gateway-1'], availability: 'available',
      capabilities: ['project_cli'], credentialReference: 'op://Vault/Item/private-key',
      credentialPurpose: 'project_control_gateway_v1',
      enabled: true, freshnessSeconds: 300, hostKeySha256: `SHA256:${'A'.repeat(43)}`,
      id: routeId, lastVerifiedAt, ownerUserId: owner, policyState: 'approved',
      priority: 10, privateAddress: '100.64.0.10', privateNetworkId: networkId,
      providerKind: 'tailscale', requiresInteractiveApproval: false,
      routeKind: 'ssh_private_network', sshPort: 22, sshUser: 'ssh-user',
      target: { id: environmentId, kind: 'environment' },
      targetIdentityRevision: revision, verifiedUntil
    }]
  };
}

function successfulTransport(calls: string[]): SshControlTransport {
  return {
    verifyHost: async () => {
      calls.push('verify-host');
      return { address: '100.64.0.10', knownHostEntry: 'verified-host-state' };
    },
    handshake: async () => {
      calls.push('ssh-handshake');
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          cliVersion: '0.5.0', operations: ['status.v1'], protocolVersion: 1,
          schemaVersion: 1, type: 'handshake'
        }),
        timedOut: false
      };
    },
    execute: async ({ request: operation }) => {
      calls.push('ssh');
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
            checkedAt: new Date().toISOString(), operation: 'status.v1',
            operationId: operation.operationId, schemaVersion: 1, state: 'ready',
            targetIdentityRevision: revision, type: 'result'
          }),
        timedOut: false
      };
    }
  };
}
