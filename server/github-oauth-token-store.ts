import type { DatabaseQueryClient } from './database/client';
import {
  decryptGitHubOAuthToken,
  encryptGitHubOAuthToken,
  GitHubOAuthTokenUnreadableError
} from './github-oauth-token-encryption';
import { projectSpaceLogger, type ProjectSpaceLogger } from './observability';

export interface StoredGitHubOAuthToken {
  accessToken: string;
  createdAt: string;
  login?: string;
  scope?: string;
  tokenType?: string;
}

interface GitHubOAuthTokenRow {
  created_at: Date;
  encrypted_access_token: string;
  iv: string;
  login: string | null;
  scope: string | null;
  tag: string;
  token_type: string | null;
}

export type StoredGitHubOAuthTokenResult =
  | { status: 'connected'; token: StoredGitHubOAuthToken }
  | { status: 'missing' }
  | { status: 'reconnect-required' };

interface GitHubOAuthTokenStoreOptions {
  client: DatabaseQueryClient;
  databaseUrl: string;
  environment?: NodeJS.ProcessEnv;
  logger?: ProjectSpaceLogger;
}

export class GitHubOAuthTokenStore {
  private readonly logger: ProjectSpaceLogger;

  constructor(private readonly options: GitHubOAuthTokenStoreOptions) {
    this.logger = options.logger ?? projectSpaceLogger;
  }

  private encryptionOptions() {
    return {
      databaseUrl: this.options.databaseUrl,
      environment: this.options.environment
    };
  }

  async read(userId: string): Promise<StoredGitHubOAuthTokenResult> {
    const result = await this.options.client.query<GitHubOAuthTokenRow>(
      `select login, encrypted_access_token, iv, tag, scope, token_type, created_at
         from github_oauth_tokens
        where user_id = $1`,
      [userId]
    );
    const row = result.rows[0];

    if (!row) return { status: 'missing' };

    let decrypted: ReturnType<typeof decryptGitHubOAuthToken>;
    try {
      decrypted = decryptGitHubOAuthToken({
        encrypted: row.encrypted_access_token,
        iv: row.iv,
        tag: row.tag
      }, this.encryptionOptions());
    } catch (error) {
      if (error instanceof GitHubOAuthTokenUnreadableError) {
        return { status: 'reconnect-required' };
      }
      throw error;
    }

    if (decrypted.usedLegacyKey) {
      const migrated = encryptGitHubOAuthToken(decrypted.token, this.encryptionOptions());
      try {
        await this.options.client.query(
          `update github_oauth_tokens
              set encrypted_access_token = $2,
                  iv = $3,
                  tag = $4,
                  updated_at = now()
            where user_id = $1
              and encrypted_access_token = $5
              and iv = $6
              and tag = $7`,
          [
            userId,
            migrated.encrypted,
            migrated.iv,
            migrated.tag,
            row.encrypted_access_token,
            row.iv,
            row.tag
          ]
        );
        this.logger.info('github.oauth.token.encryption_migrated', {
          source: 'legacy-key'
        });
      } catch {
        this.logger.warn('github.oauth.token.encryption_migration_failed');
      }
    }

    return {
      status: 'connected',
      token: {
        accessToken: decrypted.token,
        createdAt: row.created_at.toISOString(),
        login: row.login ?? undefined,
        scope: row.scope ?? undefined,
        tokenType: row.token_type ?? undefined
      }
    };
  }

  async write(userId: string, token: StoredGitHubOAuthToken) {
    const encrypted = encryptGitHubOAuthToken(token.accessToken, this.encryptionOptions());

    await this.options.client.query(
      `insert into github_oauth_tokens (
          user_id, login, encrypted_access_token, iv, tag, scope, token_type, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, now(), now())
        on conflict (user_id) do update set
          login = excluded.login,
          encrypted_access_token = excluded.encrypted_access_token,
          iv = excluded.iv,
          tag = excluded.tag,
          scope = excluded.scope,
          token_type = excluded.token_type,
          updated_at = now()`,
      [
        userId,
        token.login ?? null,
        encrypted.encrypted,
        encrypted.iv,
        encrypted.tag,
        token.scope ?? null,
        token.tokenType ?? null
      ]
    );
  }
}
