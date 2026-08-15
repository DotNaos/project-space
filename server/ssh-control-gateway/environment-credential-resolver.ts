import { isCredentialReference } from '../private-network/contracts';
import type { SshCredentialResolver } from './contracts';
import { SshGatewayError } from './contracts';

export interface CredentialEnvironment {
  read(name: string): string | undefined;
}

export class EnvironmentSshCredentialResolver implements SshCredentialResolver {
  constructor(
    private readonly environment: CredentialEnvironment = {
      read: (name) => process.env[name]
    }
  ) {}

  async resolve(reference: string) {
    if (!isCredentialReference(reference)) throw unavailable();
    const name = reference.slice('env://'.length);
    const privateKey = this.environment.read(name);
    if (!privateKey?.trim() || Buffer.byteLength(privateKey) > 64 * 1024) {
      throw unavailable();
    }
    return { privateKey, purpose: 'project_control_gateway_v1' as const };
  }
}

function unavailable() {
  return new SshGatewayError('credential_unavailable', 'SSH credential is unavailable.');
}
