import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const credentialKeyEnvironment = 'PROJECT_SPACE_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_B64';
const credentialKeyIdEnvironment = 'PROJECT_SPACE_PROVIDER_CREDENTIAL_ENCRYPTION_KEY_ID';
const keyIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const base64KeyPattern = /^[A-Za-z0-9+/]{43}=$/;

export interface ProviderCredential {
  clientId: string;
  clientSecret: string;
}

export interface EncryptedProviderCredentialEnvelope {
  ciphertext: string;
  iv: string;
  keyId: string;
  tag: string;
}

export class ProviderCredentialVaultError extends Error {
  constructor() {
    super('Provider credentials are unavailable.');
    this.name = 'ProviderCredentialVaultError';
  }
}

export class ProviderCredentialVault {
  constructor(
    private readonly key: Buffer,
    readonly keyId: string
  ) {}

  encrypt(credential: ProviderCredential): EncryptedProviderCredentialEnvelope {
    validateCredential(credential);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(credential), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    plaintext.fill(0);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      keyId: this.keyId,
      tag: cipher.getAuthTag().toString('base64')
    };
  }

  decrypt(envelope: EncryptedProviderCredentialEnvelope): ProviderCredential {
    if (envelope.keyId !== this.keyId) throw new ProviderCredentialVaultError();
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final()
      ]);
      try {
        const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new ProviderCredentialVaultError();
        }
        const credential = parsed as ProviderCredential;
        validateCredential(credential);
        return { clientId: credential.clientId, clientSecret: credential.clientSecret };
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (error instanceof ProviderCredentialVaultError) throw error;
      throw new ProviderCredentialVaultError();
    }
  }
}

export function createProviderCredentialVault(environment: NodeJS.ProcessEnv = process.env) {
  const encodedKey = environment[credentialKeyEnvironment]?.trim() ?? '';
  const keyId = environment[credentialKeyIdEnvironment]?.trim() ?? '';
  if (!base64KeyPattern.test(encodedKey) || !keyIdPattern.test(keyId)) {
    throw new ProviderCredentialVaultError();
  }
  const key = Buffer.from(encodedKey, 'base64');
  if (key.byteLength !== 32 || key.toString('base64') !== encodedKey) {
    key.fill(0);
    throw new ProviderCredentialVaultError();
  }
  return new ProviderCredentialVault(key, keyId);
}

function validateCredential(credential: ProviderCredential) {
  if (!isSafeCredentialValue(credential.clientId, 512) ||
    !isSafeCredentialValue(credential.clientSecret, 4_096)) {
    throw new ProviderCredentialVaultError();
  }
}

function isSafeCredentialValue(value: unknown, maximumLength: number) {
  return typeof value === 'string' && value.trim() === value &&
    value.length > 0 && value.length <= maximumLength && !/[\u0000-\u001f\u007f]/.test(value);
}
