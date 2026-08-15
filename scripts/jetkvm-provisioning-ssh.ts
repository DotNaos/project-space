import {
  mkdtemp,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { JetKvmMqttBinding } from '../server/machine-power/config';

interface CommandOptions {
  allowFailure?: boolean;
  env?: Record<string, string>;
  input?: string | Uint8Array;
  timeoutMs?: number;
}

export class SecureSshSession {
  private constructor(
    readonly address: string,
    private readonly root: string,
    private readonly socket: string,
    private readonly agentPid: string
  ) {}

  static async open(address: string, binding: JetKvmMqttBinding) {
    const root = await mkdtemp(resolve(tmpdir(), 'jetkvm-provision-'));
    const knownHosts = resolve(root, 'known_hosts');
    const socket = resolve(root, 'ssh-agent.sock');
    let agentPid: string | undefined;
    try {
      const scannedKey = await command(
        'ssh-keyscan',
        ['-T', '5', '-t', 'ed25519', address]
      );
      const fingerprint = await command(
        'ssh-keygen',
        ['-lf', '-', '-E', 'sha256'],
        { input: scannedKey }
      );
      if (!fingerprint.includes(
        binding.provisioning.identity.sshHostKeySha256
      )) {
        throw new Error('The JetKVM SSH host key does not match the binding.');
      }
      await writeFile(knownHosts, scannedKey, { mode: 0o600 });
      const agent = await command('ssh-agent', ['-a', socket, '-s']);
      agentPid = agent.match(/SSH_AGENT_PID=([0-9]+)/)?.[1];
      if (!agentPid) {
        throw new Error('Could not start a private SSH agent.');
      }
      const privateKey = environmentRead(
        binding.provisioning.identity.sshPrivateKeyRef
      );
      await command('ssh-add', ['-'], {
        env: { SSH_AUTH_SOCK: socket },
        input: privateKey
      });
      const publicKey = environmentRead(
        binding.provisioning.identity.sshPublicKeyRef
      );
      const expectedKey = await command(
        'ssh-keygen',
        ['-lf', '-', '-E', 'sha256'],
        { input: publicKey }
      );
      const loadedKeys = await command('ssh-add', ['-l', '-E', 'sha256'], {
        env: { SSH_AUTH_SOCK: socket }
      });
      const expectedFingerprint =
        expectedKey.match(/SHA256:[A-Za-z0-9+/]+/)?.[0];
      if (!expectedFingerprint ||
          !loadedKeys.includes(expectedFingerprint)) {
        throw new Error('The loaded SSH key does not match its public key.');
      }
      return new SecureSshSession(address, root, socket, agentPid);
    } catch (error) {
      if (agentPid) {
        await command('ssh-agent', ['-k'], {
          allowFailure: true,
          env: { SSH_AGENT_PID: agentPid, SSH_AUTH_SOCK: socket }
        });
      }
      await rm(root, { recursive: true });
      throw error;
    }
  }

  async ssh(
    remoteCommand: string,
    input?: string | Uint8Array,
    allowFailure = false
  ) {
    return command(
      'ssh',
      [
        '-o', `IdentityAgent=${this.socket}`,
        '-o', `UserKnownHostsFile=${resolve(this.root, 'known_hosts')}`,
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        `root@${this.address}`,
        remoteCommand
      ],
      {
        allowFailure,
        env: { SSH_AUTH_SOCK: this.socket },
        input
      }
    );
  }

  async close() {
    await command('ssh-agent', ['-k'], {
      allowFailure: true,
      env: {
        SSH_AGENT_PID: this.agentPid,
        SSH_AUTH_SOCK: this.socket
      }
    });
    await rm(this.root, { recursive: true });
  }
}

export function environmentRead(reference: string) {
  const match = /^env:\/\/([A-Z_][A-Z0-9_]{0,127})$/.exec(reference);
  const value = match ? Bun.env[match[1]!] : undefined;
  if (!value || Buffer.byteLength(value) > 64 * 1024) {
    throw new Error('Provisioning credential is unavailable.');
  }
  return value;
}

async function command(
  executable: string,
  args: string[],
  options: CommandOptions = {}
) {
  const process = Bun.spawn([executable, ...args], {
    env: { ...Bun.env, ...options.env },
    stderr: 'pipe',
    stdin: options.input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe'
  });
  if (options.input !== undefined && process.stdin) {
    process.stdin.write(options.input);
    process.stdin.end();
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    process.kill();
  }, options.timeoutMs ?? 60_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) {
    if (options.allowFailure) {
      return '__COMMAND_FAILED__';
    }
    if (timedOut) {
      throw new Error(`${executable} failed: command timed out`);
    }
    const summary = (
      stderr.trim().split('\n').slice(-1)[0] || 'unknown error'
    ).replace(/tskey-[^\s]+/g, '[REDACTED]');
    throw new Error(`${executable} failed: ${summary}`);
  }
  return stdout;
}
