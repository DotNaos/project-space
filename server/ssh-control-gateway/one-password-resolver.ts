import { execFile } from 'node:child_process';

import { isCredentialReference } from '../private-network/contracts';
import type { SshCredentialResolver } from './contracts';
import { SshGatewayError } from './contracts';

export interface OnePasswordCommandRunner {
  read(reference: string): Promise<string>;
}

export class OnePasswordSshCredentialResolver implements SshCredentialResolver {
  constructor(private readonly command: OnePasswordCommandRunner = new OpReadCommandRunner()) {}

  async resolve(reference: string) {
    if (!isCredentialReference(reference)) throw unavailable();
    try {
      const privateKey = await this.command.read(reference);
      if (!privateKey.trim() || Buffer.byteLength(privateKey) > 64 * 1024) throw new Error();
      return { privateKey, purpose: 'project_control_gateway_v1' as const };
    } catch {
      throw unavailable();
    }
  }
}

export class OpReadCommandRunner implements OnePasswordCommandRunner {
  constructor(private readonly binary = 'op') {}

  read(reference: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        ['read', '--no-newline', reference],
        {
          encoding: 'utf8',
          env: process.env,
          maxBuffer: 64 * 1024,
          timeout: 10_000,
          windowsHide: true
        },
        (error, stdout) => error ? reject(error) : resolve(stdout)
      );
    });
  }
}

function unavailable() {
  return new SshGatewayError('credential_unavailable', 'SSH credential is unavailable.');
}
