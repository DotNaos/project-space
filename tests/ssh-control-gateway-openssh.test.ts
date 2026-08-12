import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';

import { describe, expect, test } from 'bun:test';

import type { AuthorizedAccessRouteSelection } from '../server/private-network/contracts';
import {
  OpenSshControlTransport,
  SpawnSshProcessRunner,
  type SshProcessInput,
  type SshProcessRunner
} from '../server/ssh-control-gateway/openssh-transport';

const publicKey = Buffer.from('bounded-ed25519-test-key').toString('base64');
const pin = `SHA256:${createHash('sha256').update(Buffer.from(publicKey, 'base64'))
  .digest('base64').replace(/=+$/, '')}`;

describe('OpenSSH control transport', () => {
  test('pins the observed host and invokes only the fixed restricted gateway command', async () => {
    const calls: SshProcessInput[] = [];
    const runner: SshProcessRunner = {
      run: async (input) => {
        calls.push(input);
        if (input.command.endsWith('ssh-keyscan')) {
          return {
            exitCode: 0, stderr: '', timedOut: false,
            stdout: `100.64.0.10 ssh-ed25519 ${publicKey}\n`
          };
        }
        return { exitCode: 0, stderr: '', stdout: 'result', timedOut: false };
      }
    };
    const transport = new OpenSshControlTransport(runner);
    const route = sshRoute();
    const verifiedHost = await transport.verifyHost({ route, timeoutMs: 5_000 });
    const credential = {
      privateKey: 'SECRET PRIVATE KEY', purpose: 'project_control_gateway_v1' as const
    };
    await transport.handshake({ credential, route, timeoutMs: 10_000, verifiedHost });
    await transport.execute({
      credential,
      handshake: { cliVersion: '0.5.0', protocolVersion: 1 },
      request: {
        environmentId: route.target.id, operation: 'status.v1', operationId: 'operation-1'
      },
      route,
      timeoutMs: 30_000,
      verifiedHost
    });

    expect(calls).toHaveLength(3);
    const handshake = calls[1]!;
    const ssh = calls[2]!;
    expect(ssh.command).toBe('/usr/bin/ssh');
    expect(ssh.argv.at(-1)).toBe('/usr/local/bin/project control-gateway --stdio');
    expect(ssh.argv).toContain('StrictHostKeyChecking=yes');
    expect(ssh.argv).toContain('ProxyCommand=none');
    expect(ssh.argv).toContain('ProxyJump=none');
    expect(ssh.argv).toContain('ForwardAgent=no');
    expect(ssh.argv).toContain('RequestTTY=no');
    expect(ssh.argv).not.toContain('sh');
    expect(ssh.argv).not.toContain('-c');
    expect(JSON.stringify({ args: ssh.argv, env: ssh.environment })).not.toContain('SECRET PRIVATE KEY');
    expect(ssh.environment.SSH_AUTH_SOCK).toBeUndefined();
    expect(handshake.stdin).toBe('{"schemaVersion":1,"type":"handshake"}\n');
    expect(ssh.stdin).toContain('"expectedCliVersion":"0.5.0"');
    expect(ssh.stdin).toContain('"operation":"status.v1"');
    expect(ssh.stdin).not.toContain('"type":"handshake"');
    const keyPath = ssh.argv[ssh.argv.indexOf('-i') + 1]!;
    await expect(access(keyPath)).rejects.toBeDefined();
  });

  test('rejects a public target before running keyscan', async () => {
    let called = false;
    const transport = new OpenSshControlTransport({
      run: async () => { called = true; throw new Error('must not run'); }
    });
    await expect(transport.verifyHost({
      route: { ...sshRoute(), privateAddress: '203.0.113.10' }, timeoutMs: 5_000
    })).rejects.toMatchObject({ code: 'route_unavailable' });
    expect(called).toBe(false);
  });

  test('rejects a mismatched or ambiguous observed host key', async () => {
    for (const stdout of [
      `100.64.0.10 ssh-ed25519 ${Buffer.from('wrong').toString('base64')}\n`,
      `100.64.0.10 ssh-ed25519 ${publicKey}\n100.64.0.10 ssh-ed25519 ${Buffer.from('other').toString('base64')}\n`
    ]) {
      const transport = new OpenSshControlTransport({
        run: async () => ({ exitCode: 0, stderr: '', stdout, timedOut: false })
      });
      await expect(transport.verifyHost({ route: sshRoute(), timeoutMs: 5_000 }))
        .rejects.toMatchObject({ code: 'host_key_mismatch' });
    }
  });

  test('turns an early remote stdin close into a bounded error instead of an unhandled EPIPE', async () => {
    await expect(new SpawnSshProcessRunner().run({
      argv: [], command: '/usr/bin/false', environment: {},
      stdin: 'x'.repeat(256 * 1024), timeoutMs: 1_000
    })).rejects.toMatchObject({ code: 'remote_failed' });
  });
});

function sshRoute(): AuthorizedAccessRouteSelection {
  return {
    credentialReference: 'op://Vault/Item/private-key',
    credentialPurpose: 'project_control_gateway_v1',
    hostKeySha256: pin,
    ownerUserId: 'user-1',
    privateAddress: '100.64.0.10',
    privateNetworkId: '33333333-3333-4333-8333-333333333333',
    routeId: '22222222-2222-4222-8222-222222222222',
    routeKind: 'ssh_private_network',
    sshPort: 22,
    sshUser: 'ssh-user',
    target: { id: '11111111-1111-4111-8111-111111111111', kind: 'environment' },
    targetIdentityRevision: '1:environment:test'
  };
}
