import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { AccessRouteAuthorization } from '../server/private-network/contracts';
import { MemorySshGatewayOperationStore } from '../server/ssh-control-gateway/memory-store';
import {
  OpenSshControlTransport,
  type SshProcessInput,
  type SshProcessRunner
} from '../server/ssh-control-gateway/openssh-transport';
import { SshControlGatewayService } from '../server/ssh-control-gateway/service';

const environmentId = '11111111-1111-4111-8111-111111111111';
const routeId = '22222222-2222-4222-8222-222222222222';
const networkId = '33333333-3333-4333-8333-333333333333';
const revision = '1:environment:test';
const publicKey = Buffer.from('cross-language-ed25519-key').toString('base64');
const pin = `SHA256:${createHash('sha256').update(Buffer.from(publicKey, 'base64'))
  .digest('base64').replace(/=+$/, '')}`;

let directory = '';
let helper = '';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'project-control-contract-'));
  helper = join(directory, 'project-control-contract');
  const build = Bun.spawn({
    cmd: [
      'go', 'test', '-c', '-ldflags',
      '-X github.com/DotNaos/project-space/cmd/project.projectMachineClientVersion=0.5.0-test',
      '-o', helper, './cmd/project'
    ],
    stderr: 'pipe', stdout: 'pipe'
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) throw new Error(await new Response(build.stderr).text());
}, 30_000);

afterAll(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
});

describe('SSH control gateway cross-language contract', () => {
  test('runs the TypeScript service and OpenSSH frames through the real Go gateway parser', async () => {
    const processRunner: SshProcessRunner = {
      async run(input) {
        if (input.command.endsWith('ssh-keyscan')) {
          return {
            exitCode: 0, stderr: '', timedOut: false,
            stdout: `100.64.0.10 ssh-ed25519 ${publicKey}\n`
          };
        }
        return runGoGateway(input);
      }
    };
    const transport = new OpenSshControlTransport(processRunner);
    const authorization = (): AccessRouteAuthorization => ({
      allowed: true, capability: 'project_cli',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), gatewayId: 'gateway-one',
      ownerUserId: 'owner-one', reason: 'contract-test', risk: 'normal',
      target: { id: environmentId, identityRevision: revision, kind: 'environment' }
    });
    const checkedAt = new Date(Date.now() - 1_000).toISOString();
    const verifiedUntil = new Date(Date.now() + 60_000).toISOString();
    const service = new SshControlGatewayService({
      authorization: { authorize: async () => authorization() },
      credentials: { resolve: async () => ({
        privateKey: 'TEST PRIVATE KEY', purpose: 'project_control_gateway_v1'
      }) },
      operations: new MemorySshGatewayOperationStore(),
      routes: { load: async () => ({
        networks: [{
          approvalState: 'approved', availability: 'available', enabled: true,
          id: networkId, lastVerifiedAt: checkedAt, name: 'private', ownerUserId: 'owner-one',
          providerKind: 'tailscale', providerReference: 'provider', verifiedUntil
        }],
        routes: [{
          allowedGatewayIds: ['gateway-one'], availability: 'available',
          capabilities: ['project_cli'], credentialPurpose: 'project_control_gateway_v1',
          credentialReference: 'op://Contract/Control/private-key', enabled: true,
          freshnessSeconds: 300, hostKeySha256: pin, id: routeId,
          lastVerifiedAt: checkedAt, ownerUserId: 'owner-one', policyState: 'approved',
          priority: 100, privateAddress: '100.64.0.10', privateNetworkId: networkId,
          providerKind: 'tailscale', requiresInteractiveApproval: false,
          routeKind: 'ssh_private_network', sshPort: 22, sshUser: 'project-control',
          target: { id: environmentId, kind: 'environment' },
          targetIdentityRevision: revision, verifiedUntil
        }]
      }) },
      targets: { resolve: async () => ({
        environmentDefinitionId: 'definition-one', environmentId,
        platformId: 'platform-one', targetIdentityRevision: revision
      }) },
      transport
    });
    const result = await service.execute(
      { id: 'machine-one', kind: 'machine', ownerUserId: 'owner-one' },
      { environmentId, operation: 'status.v1', operationId: 'contract-operation-one' }
    );
    expect(result.result).toMatchObject({
      operationId: 'contract-operation-one', state: 'ready', targetIdentityRevision: revision
    });
    expect(result.audit).toMatchObject({
      actorId: 'machine-one', routeId, targetEnvironmentId: environmentId
    });
  });

  test('carries one replay-fenced Workspace runtime start through the authorized SSH path', async () => {
    const processRunner: SshProcessRunner = {
      async run(input) {
        if (input.command.endsWith('ssh-keyscan')) {
          return { exitCode: 0, stderr: '', timedOut: false, stdout: `100.64.0.10 ssh-ed25519 ${publicKey}\n` };
        }
        return runGoGateway(input);
      }
    };
    const checkedAt = new Date(Date.now() - 1_000).toISOString();
    const verifiedUntil = new Date(Date.now() + 60_000).toISOString();
    const service = new SshControlGatewayService({
      authorization: { authorize: async () => ({
        allowed: true, capability: 'project_cli', expiresAt: verifiedUntil,
        gatewayId: 'gateway-one', ownerUserId: 'owner-one', reason: 'contract-test',
        risk: 'normal', target: { id: environmentId, identityRevision: revision, kind: 'environment' }
      }) },
      credentials: { resolve: async () => ({ privateKey: 'TEST PRIVATE KEY', purpose: 'project_control_gateway_v1' }) },
      operations: new MemorySshGatewayOperationStore(),
      routes: { load: async () => ({
        networks: [{
          approvalState: 'approved', availability: 'available', enabled: true,
          id: networkId, lastVerifiedAt: checkedAt, name: 'private', ownerUserId: 'owner-one',
          providerKind: 'tailscale', providerReference: 'provider', verifiedUntil
        }],
        routes: [{
          allowedGatewayIds: ['gateway-one'], availability: 'available', capabilities: ['project_cli'],
          credentialPurpose: 'project_control_gateway_v1', credentialReference: 'op://Contract/Control/private-key',
          enabled: true, freshnessSeconds: 300, hostKeySha256: pin, id: routeId,
          lastVerifiedAt: checkedAt, ownerUserId: 'owner-one', policyState: 'approved', priority: 100,
          privateAddress: '100.64.0.10', privateNetworkId: networkId, providerKind: 'tailscale',
          requiresInteractiveApproval: false, routeKind: 'ssh_private_network', sshPort: 22,
          sshUser: 'project-control', target: { id: environmentId, kind: 'environment' },
          targetIdentityRevision: revision, verifiedUntil
        }]
      }) },
      targets: { resolve: async () => ({
        environmentDefinitionId: 'definition-one', environmentId,
        platformId: 'platform-one', targetIdentityRevision: revision
      }) },
      transport: new OpenSshControlTransport(processRunner)
    });
    const request = {
      environmentId,
      expectedCommit: '0123456789abcdef0123456789abcdef01234567',
      expectedGeneration: '123e4567-e89b-42d3-a456-426614174000',
      expectedManifestDigest: 'a'.repeat(64),
      mode: 'process' as const,
      operation: 'workspace-runtime.start.v1' as const,
      operationId: 'workspace-contract-operation-one',
      runtimeSessionCapabilities: ['runtime.lifecycle', 'runtime.heartbeat'],
      runtimeSessionEndpoint: 'wss://projects.os-home.net/api/workspace-runtimes/socket',
      runtimeSessionExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      expectedBranch: 'issue-625', expectedRuntimeVersion: '0.5.0-test',
      runtimeSessionOwnerUserId: 'owner-one',
      runtimeSessionRequestedCapabilities: ['runtime.control.v1'],
      runtimeSessionToken: 'A'.repeat(43),
      runtimeSessionVersion: '0.5.0-test',
      workspaceId: '123e4567-e89b-42d3-a456-426614174001'
    };
    const first = await service.execute(
      { id: 'machine-one', kind: 'machine', ownerUserId: 'owner-one' }, request
    );
    const replay = await service.execute(
      { id: 'machine-one', kind: 'machine', ownerUserId: 'owner-one' }, request
    );
    expect(first.result).toMatchObject({
      operation: request.operation, state: 'running', workspaceId: request.workspaceId
    });
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect(JSON.stringify(first)).not.toContain(request.runtimeSessionToken);
  });
});

async function runGoGateway(input: SshProcessInput) {
  const child = Bun.spawn({
    cmd: [helper, '-test.run=^TestControlGatewayContractProcess$'],
    env: {
      ...process.env,
      PROJECT_CONTROL_GATEWAY_CONTRACT_HELPER: '1',
      ...(input.stdin?.includes('workspace-runtime.')
        ? { PROJECT_CONTROL_GATEWAY_WORKSPACE_HELPER: '1' }
        : {})
    },
    stderr: 'pipe', stdin: 'pipe', stdout: 'pipe'
  });
  child.stdin.write(input.stdin ?? '');
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { exitCode, stderr, stdout, timedOut: false };
}
