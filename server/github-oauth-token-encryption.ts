import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface EncryptedGitHubOAuthToken {
  encrypted: string;
  iv: string;
  tag: string;
}

interface GitHubOAuthTokenEncryptionOptions {
  databaseUrl: string;
  environment?: NodeJS.ProcessEnv;
}

export class GitHubOAuthTokenEncryptionConfigurationError extends Error {
  constructor() {
    super('GitHub connection storage is unavailable because token encryption is not configured.');
    this.name = 'GitHubOAuthTokenEncryptionConfigurationError';
  }
}

export const githubOAuthReconnectMessage =
  'The saved GitHub connection can no longer be read. Reconnect GitHub to continue.';

export class GitHubOAuthTokenUnreadableError extends Error {
  constructor() {
    super(githubOAuthReconnectMessage);
    this.name = 'GitHubOAuthTokenUnreadableError';
  }
}

function normalized(value?: string) {
  return value?.trim() ?? '';
}

export function hasDedicatedGitHubOAuthTokenEncryptionKey(
  environment: NodeJS.ProcessEnv = process.env
) {
  return normalized(environment.PROJECT_SPACE_TOKEN_ENCRYPTION_KEY).length >= 32;
}

function encryptionKey(source: string) {
  return createHash('sha256').update(source).digest();
}

function encryptionSources({
  databaseUrl,
  environment = process.env
}: GitHubOAuthTokenEncryptionOptions) {
  const dedicated = normalized(environment.PROJECT_SPACE_TOKEN_ENCRYPTION_KEY);
  if (dedicated && dedicated.length < 32) {
    throw new GitHubOAuthTokenEncryptionConfigurationError();
  }
  const legacy = [
    normalized(environment.CLERK_SECRET_KEY),
    normalized(databaseUrl)
  ].filter((source, index, sources) => source && sources.indexOf(source) === index);
  const primary = dedicated || legacy[0];

  if (!primary) {
    throw new GitHubOAuthTokenEncryptionConfigurationError();
  }

  return {
    legacy: dedicated ? legacy.filter((source) => source !== dedicated) : [],
    primary
  };
}

function decryptWithSource(row: EncryptedGitHubOAuthToken, source: string) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(source),
    Buffer.from(row.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(row.tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(row.encrypted, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

export function encryptGitHubOAuthToken(
  value: string,
  options: GitHubOAuthTokenEncryptionOptions
): EncryptedGitHubOAuthToken {
  const { primary } = encryptionSources(options);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(primary), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

export function decryptGitHubOAuthToken(
  row: EncryptedGitHubOAuthToken,
  options: GitHubOAuthTokenEncryptionOptions
) {
  const { legacy, primary } = encryptionSources(options);
  const candidates = [primary, ...legacy];

  for (const [index, source] of candidates.entries()) {
    try {
      return {
        token: decryptWithSource(row, source),
        usedLegacyKey: index > 0
      };
    } catch {
      // Try only the explicitly bounded legacy sources; never expose crypto details.
    }
  }

  throw new GitHubOAuthTokenUnreadableError();
}
