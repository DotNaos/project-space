import { createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { isPrivateAddress } from '../private-network/contracts';
import type {
  SshControlTransport,
  SshTransportResult,
  VerifiedSshHost
} from './contracts';
import { SshGatewayError } from './contracts';

const outputLimit = 64 * 1024;
const remoteGatewayCommand = '/usr/local/bin/project control-gateway --stdio';

export interface SshProcessInput {
  argv: readonly string[];
  command: string;
  environment: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs: number;
}

export interface SshProcessRunner {
  run(input: SshProcessInput): Promise<SshTransportResult>;
}

export interface PrivateAddressResolver {
  resolve(value: string): Promise<string>;
}

export class OpenSshControlTransport implements SshControlTransport {
  constructor(
    private readonly processRunner: SshProcessRunner = new SpawnSshProcessRunner(),
    private readonly addressResolver: PrivateAddressResolver = new DnsPrivateAddressResolver()
  ) {}

  async verifyHost(input: Parameters<SshControlTransport['verifyHost']>[0]) {
    const route = requireSshRoute(input.route);
    let address: string;
    try {
      address = await this.addressResolver.resolve(route.privateAddress);
    } catch {
      throw new SshGatewayError('route_unavailable', 'The SSH target is not one exact private address.');
    }
    try {
      const scanned = await this.processRunner.run({
        argv: ['-T', '5', '-p', String(route.sshPort), '-t', 'ed25519', address],
        command: '/usr/bin/ssh-keyscan',
        environment: safeEnvironment(tmpdir()),
        timeoutMs: input.timeoutMs
      });
      if (scanned.timedOut || scanned.exitCode !== 0 ||
        Buffer.byteLength(scanned.stdout) > outputLimit) throw new Error('scan failed');
      const publicKey = oneEd25519Key(scanned.stdout);
      const actual = opensshFingerprint(publicKey);
      if (!sameFingerprint(actual, route.hostKeySha256)) throw new Error('key mismatch');
      return {
        address,
        knownHostEntry: `${hostAlias(route.routeId)} ${publicKey}`
      } satisfies VerifiedSshHost;
    } catch {
      throw new SshGatewayError('host_key_mismatch', 'The pinned SSH host identity does not match.');
    }
  }

  async handshake(input: Parameters<SshControlTransport['handshake']>[0]) {
    return this.invoke(input, `${JSON.stringify({ schemaVersion: 1, type: 'handshake' })}\n`);
  }

  async execute(input: Parameters<SshControlTransport['execute']>[0]) {
    return this.invoke(input, operationFrame(
      input.request, input.route.targetIdentityRevision, input.handshake
    ));
  }

  private async invoke(
    input: Pick<Parameters<SshControlTransport['execute']>[0],
      'credential' | 'route' | 'timeoutMs' | 'verifiedHost'>,
    stdin: string
  ) {
    const route = requireSshRoute(input.route);
    if (input.credential.purpose !== 'project_control_gateway_v1' ||
      route.credentialPurpose !== 'project_control_gateway_v1') {
      throw new SshGatewayError('credential_unavailable', 'SSH credential scope is invalid.');
    }
    if (!verifiedHostIsValid(input.verifiedHost, route.routeId, route.hostKeySha256)) {
      throw new SshGatewayError('host_key_mismatch', 'The verified SSH host is invalid.');
    }
    const directory = await mkdtemp(join(tmpdir(), 'project-ssh-gateway-'));
    const privateKeyPath = join(directory, 'identity');
    const knownHostsPath = join(directory, 'known_hosts');
    const certificatePath = join(directory, 'identity-cert.pub');
    try {
      await writeFile(privateKeyPath, input.credential.privateKey, {
        encoding: 'utf8', flag: 'wx', mode: 0o600
      });
      await writeFile(knownHostsPath, `${input.verifiedHost.knownHostEntry}\n`, {
        encoding: 'utf8', flag: 'wx', mode: 0o600
      });
      if (input.credential.certificate) {
        await writeFile(certificatePath, input.credential.certificate, {
          encoding: 'utf8', flag: 'wx', mode: 0o600
        });
      }
      const alias = hostAlias(route.routeId);
      const argv = [
        '-F', '/dev/null',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${knownHostsPath}`,
        '-o', 'GlobalKnownHostsFile=/dev/null',
        '-o', `HostKeyAlias=${alias}`,
        '-o', `Hostname=${input.verifiedHost.address}`,
        '-o', 'CheckHostIP=no',
        '-o', 'VerifyHostKeyDNS=no',
        '-o', 'UpdateHostKeys=no',
        '-o', 'ProxyCommand=none',
        '-o', 'ProxyJump=none',
        '-o', 'ForwardAgent=no',
        '-o', 'ClearAllForwardings=yes',
        '-o', 'RequestTTY=no',
        '-o', 'PasswordAuthentication=no',
        '-o', 'KbdInteractiveAuthentication=no',
        '-o', 'PreferredAuthentications=publickey',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'IdentityAgent=none',
        '-o', 'ConnectTimeout=8',
        '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=2',
        '-i', privateKeyPath,
        ...(input.credential.certificate
          ? ['-o', `CertificateFile=${certificatePath}`]
          : []),
        '-p', String(route.sshPort),
        '-l', route.sshUser,
        alias,
        remoteGatewayCommand
      ];
      return await this.processRunner.run({
        argv,
        command: '/usr/bin/ssh',
        environment: safeEnvironment(directory),
        stdin,
        timeoutMs: input.timeoutMs
      });
    } finally {
      const removed = await Promise.allSettled([
        rm(privateKeyPath, { force: true }),
        rm(certificatePath, { force: true }),
        rm(knownHostsPath, { force: true })
      ]);
      try {
        await rm(directory, { force: true, recursive: true });
      } catch {
        throw new SshGatewayError('remote_failed', 'SSH credential cleanup failed.');
      }
      if (removed.some(({ status }) => status === 'rejected')) {
        throw new SshGatewayError('remote_failed', 'SSH credential cleanup failed.');
      }
    }
  }
}

export class DnsPrivateAddressResolver implements PrivateAddressResolver {
  async resolve(value: string) {
    if (!isPrivateAddress(value)) throw new Error('not private');
    if (isIP(value)) return value;
    const resolved = await lookup(value, { all: true, verbatim: true });
    const addresses = [...new Set(resolved.map((entry) => entry.address))]
      .filter(isPrivateAddress);
    if (addresses.length !== 1) throw new Error('ambiguous private address');
    return addresses[0]!;
  }
}

export class SpawnSshProcessRunner implements SshProcessRunner {
  run(input: SshProcessInput): Promise<SshTransportResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(input.command, [...input.argv], {
        detached: true,
        env: { ...input.environment },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let overflow = false;
      let stdinFailed = false;
      let timedOut = false;
      let settled = false;
      const collect = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>) => {
        if (current.length + chunk.length > outputLimit) {
          overflow = true;
          terminateGroup(child.pid);
          return current;
        }
        return Buffer.concat([current, chunk]);
      };
      child.stdout.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk); });
      const timer = setTimeout(() => {
        timedOut = true;
        terminateGroup(child.pid);
        setTimeout(() => killGroup(child.pid), 500).unref();
      }, input.timeoutMs);
      timer.unref();
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      child.on('error', fail);
      child.stdin.on('error', () => {
        stdinFailed = true;
        terminateGroup(child.pid);
      });
      child.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (overflow || stdinFailed) {
          reject(new SshGatewayError('remote_failed', 'SSH control process failed safely.'));
          return;
        }
        resolve({
          exitCode,
          stderr: stderr.toString('utf8'),
          stdout: stdout.toString('utf8'),
          timedOut
        });
      });
      child.stdin.end(input.stdin ?? '');
    });
  }
}

function requireSshRoute(route: Parameters<SshControlTransport['execute']>[0]['route']) {
  if (route.routeKind !== 'ssh_private_network' || !route.privateAddress ||
    !route.sshPort || !route.sshUser || !route.hostKeySha256 ||
    route.credentialPurpose !== 'project_control_gateway_v1' ||
    !/^[A-Za-z_][A-Za-z0-9._-]{0,63}$/.test(route.sshUser)) {
    throw new SshGatewayError('route_unavailable', 'SSH route is incomplete.');
  }
  return route as typeof route & {
    hostKeySha256: string;
    privateAddress: string;
    sshPort: number;
    sshUser: string;
  };
}

function oneEd25519Key(value: string) {
  const keys = value.split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 3 && parts[1] === 'ssh-ed25519')
    .map((parts) => `${parts[1]} ${parts[2]}`);
  const unique = [...new Set(keys)];
  if (unique.length !== 1) throw new Error('ambiguous host key');
  return unique[0]!;
}

function opensshFingerprint(publicKey: string) {
  const encoded = publicKey.split(' ')[1];
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid key');
  const digest = createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

function sameFingerprint(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifiedHostIsValid(host: VerifiedSshHost, routeId: string, pin: string) {
  try {
    const parts = host.knownHostEntry.split(/\s+/);
    return Boolean(isIP(host.address)) && isPrivateAddress(host.address) && parts.length === 3 &&
      parts[0] === hostAlias(routeId) && parts[1] === 'ssh-ed25519' &&
      sameFingerprint(opensshFingerprint(`${parts[1]} ${parts[2]}`), pin);
  } catch {
    return false;
  }
}

function hostAlias(routeId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(routeId)) throw new Error('invalid route id');
  return `project-route-${routeId.toLowerCase()}`;
}

function operationFrame(
  request: Parameters<SshControlTransport['execute']>[0]['request'],
  targetIdentityRevision: string,
  handshake: Parameters<SshControlTransport['execute']>[0]['handshake']
) {
  return `${JSON.stringify({
    environmentId: request.environmentId,
    ...(request.expectedBranch ? { expectedBranch: request.expectedBranch } : {}),
    expectedCliVersion: handshake.cliVersion,
    ...(request.expectedCommit ? { expectedCommit: request.expectedCommit } : {}),
    ...(request.expectedGeneration ? { expectedGeneration: request.expectedGeneration } : {}),
    ...(request.expectedManifestDigest
      ? { expectedManifestDigest: request.expectedManifestDigest }
      : {}),
    ...(request.expectedRuntimeVersion
      ? { expectedRuntimeVersion: request.expectedRuntimeVersion }
      : {}),
    expectedProtocolVersion: handshake.protocolVersion,
    ...(request.mode ? { mode: request.mode } : {}),
    operation: request.operation,
    operationId: request.operationId,
    ...(request.runtimeSessionCapabilities
      ? { runtimeSessionCapabilities: request.runtimeSessionCapabilities }
      : {}),
    ...(request.runtimeSessionEndpoint
      ? { runtimeSessionEndpoint: request.runtimeSessionEndpoint }
      : {}),
    ...(request.runtimeSessionExpiresAt
      ? { runtimeSessionExpiresAt: request.runtimeSessionExpiresAt }
      : {}),
    ...(request.runtimeSessionOwnerUserId
      ? { runtimeSessionOwnerUserId: request.runtimeSessionOwnerUserId }
      : {}),
    ...(request.runtimeSessionRequestedCapabilities
      ? { runtimeSessionRequestedCapabilities: request.runtimeSessionRequestedCapabilities }
      : {}),
    ...(request.runtimeSessionToken ? { runtimeSessionToken: request.runtimeSessionToken } : {}),
    ...(request.runtimeSessionVersion
      ? { runtimeSessionVersion: request.runtimeSessionVersion }
      : {}),
    schemaVersion: 1,
    targetIdentityRevision,
    type: 'operation',
    ...(request.workspaceId ? { workspaceId: request.workspaceId } : {})
  })}\n`;
}

function safeEnvironment(home: string) {
  return {
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin'
  };
}

function terminateGroup(pid: number | undefined) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already exited */ }
}

function killGroup(pid: number | undefined) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
}
