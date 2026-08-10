import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import express from 'express';

import { requestPublicOrigin } from './connector-installation';
import {
  isProjectSpaceAuthRequired,
  isProjectSpaceEmailAllowed,
  readAuthSessionFromRequest,
  type ProjectSpaceAuthSession
} from './local-auth-store';
import { readJson, writeJson } from './project-space-http-response';
import {
  getProjectSpaceMcpOAuthStore,
  projectSpaceMcpDefaultScopes,
  projectSpaceMcpSupportedScopes,
  type ProjectSpaceMcpOAuthStore,
  type StoredMcpCredential
} from './project-space-mcp-oauth-store';

const approvalApiPath = '/api/mcp/oauth/authorization';
const approvalPagePath = '/mcp/authorize';
const oauthPaths = new Set([
  '/authorize',
  '/token',
  '/register',
  '/revoke',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource/mcp'
]);

type SessionReader = (request: IncomingMessage) => Promise<ProjectSpaceAuthSession | null>;

export interface ProjectSpaceMcpOAuthOptions {
  getStore?: () => Promise<ProjectSpaceMcpOAuthStore>;
  readSession?: SessionReader;
}

function requestedScopes(scopes?: string[]) {
  const normalized = scopes?.filter(Boolean) ?? [];
  const selected = normalized.length > 0
    ? [...new Set(normalized)]
    : [...projectSpaceMcpDefaultScopes];
  if (selected.some((scope) => !projectSpaceMcpSupportedScopes.includes(
    scope as typeof projectSpaceMcpSupportedScopes[number]
  ))) {
    throw new InvalidScopeError('The requested Project Space scope is not supported.');
  }
  return selected;
}

function validateResource(resource: URL | undefined, expected: string) {
  const selected = resource?.toString() ?? expected;
  if (selected !== expected) throw new InvalidTargetError('The requested MCP resource is not supported.');
  return selected;
}

function isAllowedRedirectUri(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin === 'https://chatgpt.com') {
    return url.pathname.startsWith('/connector/oauth/') || url.pathname === '/connector_platform_oauth_redirect';
  }
  return (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') &&
    (url.protocol === 'http:' || url.protocol === 'https:');
}

function normalizeClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
  if (client.token_endpoint_auth_method !== 'none') {
    throw new InvalidClientMetadataError('Project Space MCP requires a public PKCE client (token_endpoint_auth_method=none).');
  }
  if (client.redirect_uris.length === 0 || client.redirect_uris.some((uri) => !isAllowedRedirectUri(uri))) {
    throw new InvalidClientMetadataError('Only ChatGPT and local loopback OAuth callback URLs are allowed.');
  }
  const grants = client.grant_types ?? ['authorization_code', 'refresh_token'];
  if (grants.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token')) {
    throw new InvalidClientMetadataError('Only authorization_code and refresh_token grants are supported.');
  }
  if (client.response_types?.some((type) => type !== 'code')) {
    throw new InvalidClientMetadataError('Only the code response type is supported.');
  }
  requestedScopes(client.scope?.split(' '));
  return {
    ...client,
    client_secret: undefined,
    client_secret_expires_at: undefined,
    grant_types: grants,
    response_types: ['code'],
    scope: client.scope || projectSpaceMcpDefaultScopes.join(' '),
    token_endpoint_auth_method: 'none'
  };
}

class ProjectSpaceOAuthProvider implements OAuthServerProvider {
  readonly clientsStore;

  constructor(
    private readonly origin: string,
    private readonly store: () => Promise<ProjectSpaceMcpOAuthStore>
  ) {
    this.clientsStore = {
      getClient: async (clientId: string) => (await this.store()).getClient(clientId),
      registerClient: async (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => {
        const normalized = normalizeClient(client as OAuthClientInformationFull);
        return (await this.store()).registerClient(normalized);
      }
    };
  }

  async authorize(client: OAuthClientInformationFull, params: Parameters<OAuthServerProvider['authorize']>[1], response: Parameters<OAuthServerProvider['authorize']>[2]) {
    const resource = validateResource(params.resource, `${this.origin}/mcp`);
    const authorization = await (await this.store()).createAuthorization({
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource,
      scopes: requestedScopes(params.scopes),
      state: params.state
    });
    response.redirect(302, `${this.origin}${approvalPagePath}?request=${encodeURIComponent(authorization.id)}`);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const credential = await (await this.store()).getCredential(code, 'authorization_code');
    if (!credential || credential.clientId !== client.client_id || !credential.codeChallenge) {
      throw new InvalidGrantError('The authorization code is invalid or expired.');
    }
    return credential.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ) {
    const store = await this.store();
    const credential = await store.consumeCredential(code, 'authorization_code', client.client_id);
    if (!credential) {
      throw new InvalidGrantError('The authorization code is invalid or expired.');
    }
    if (redirectUri !== credential.redirectUri) {
      throw new InvalidGrantError('The redirect_uri does not match the authorization request.');
    }
    validateResource(resource, credential.resource);
    return this.issueTokens(store, credential);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ) {
    const store = await this.store();
    const credential = await store.consumeCredential(refreshToken, 'refresh_token', client.client_id);
    if (!credential || !isProjectSpaceEmailAllowed(credential.userEmail)) {
      throw new InvalidGrantError('The refresh token is invalid or expired.');
    }
    validateResource(resource, credential.resource);
    const selectedScopes = scopes?.length ? requestedScopes(scopes) : credential.scopes;
    if (selectedScopes.some((scope) => !credential.scopes.includes(scope))) {
      throw new InvalidScopeError('A refresh request cannot add scopes.');
    }
    return this.issueTokens(store, { ...credential, scopes: selectedScopes });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const credential = await (await this.store()).getCredential(token, 'access_token');
    if (!credential || !isProjectSpaceEmailAllowed(credential.userEmail)) {
      throw new InvalidTokenError('The access token is invalid or expired.');
    }
    return {
      clientId: credential.clientId,
      expiresAt: Math.floor(credential.expiresAt / 1000),
      extra: { email: credential.userEmail, userId: credential.userId },
      resource: new URL(credential.resource),
      scopes: credential.scopes,
      token
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    await (await this.store()).revokeCredential(request.token);
  }

  private async issueTokens(store: ProjectSpaceMcpOAuthStore, credential: StoredMcpCredential): Promise<OAuthTokens> {
    const input = {
      clientId: credential.clientId,
      resource: credential.resource,
      scopes: credential.scopes,
      userEmail: credential.userEmail,
      userId: credential.userId
    };
    const [accessToken, refreshToken] = await Promise.all([
      store.createCredential({ ...input, kind: 'access_token' }),
      store.createCredential({ ...input, kind: 'refresh_token' })
    ]);
    return {
      access_token: accessToken,
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: credential.scopes.join(' '),
      token_type: 'bearer'
    };
  }
}

async function runExpressHandler(
  handler: ReturnType<typeof express>,
  request: IncomingMessage,
  response: ServerResponse
) {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const settle = (handled: boolean) => {
      if (settled) return;
      settled = true;
      resolve(handled);
    };
    response.once('finish', () => settle(true));
    response.once('close', () => settle(true));
    handler(request as never, response as never, (error?: unknown) => {
      if (error) reject(error);
      else settle(false);
    });
  });
}

async function defaultSessionReader(request: IncomingMessage) {
  if (!isProjectSpaceAuthRequired()) {
    return { login: 'local-development-user', role: 'user' as const, userId: 'local-development-user' };
  }
  return readAuthSessionFromRequest(request);
}

export function createProjectSpaceMcpOAuth(options: ProjectSpaceMcpOAuthOptions = {}) {
  const store = options.getStore ?? getProjectSpaceMcpOAuthStore;
  const readSession = options.readSession ?? defaultSessionReader;
  const providers = new Map<string, ProjectSpaceOAuthProvider>();
  const routers = new Map<string, ReturnType<typeof express>>();

  function providerFor(origin: string) {
    let provider = providers.get(origin);
    if (!provider) {
      provider = new ProjectSpaceOAuthProvider(origin, store);
      providers.set(origin, provider);
    }
    return provider;
  }

  function routerFor(origin: string) {
    let router = routers.get(origin);
    if (!router) {
      const baseUrl = new URL(origin);
      const app = express();
      app.set('trust proxy', 1);
      app.use(mcpAuthRouter({
        baseUrl,
        clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
        issuerUrl: baseUrl,
        provider: providerFor(origin),
        resourceName: 'Project Space MCP',
        resourceServerUrl: new URL('/mcp', origin),
        scopesSupported: [...projectSpaceMcpSupportedScopes],
        serviceDocumentationUrl: new URL('/docs/project-mcp', origin)
      }));
      router = app;
      routers.set(origin, router);
    }
    return router;
  }

  return {
    async handle(request: IncomingMessage, response: ServerResponse, url: URL) {
      if (url.pathname === approvalApiPath) {
        response.setHeader('Cache-Control', 'no-store');
        if (request.method !== 'GET' && request.method !== 'POST') {
          response.writeHead(405, { Allow: 'GET, POST' }).end();
          return true;
        }
        const session = await readSession(request);
        if (!session) {
          writeJson(response, 401, { error: 'Sign in to approve this MCP connection.' });
          return true;
        }
        const body = request.method === 'POST'
          ? await readJson<{ requestId?: string; decision?: string }>(request).catch(() => undefined)
          : undefined;
        if (request.method === 'POST' && !body) {
          writeJson(response, 400, { error: 'The request body must be valid JSON.' });
          return true;
        }
        const requestId = request.method === 'GET'
          ? url.searchParams.get('request')?.trim()
          : body?.requestId?.trim();
        if (!requestId) {
          writeJson(response, 400, { error: 'The authorization request is missing.' });
          return true;
        }
        if (request.method === 'POST' && body?.decision !== 'approve' && body?.decision !== 'deny') {
          writeJson(response, 400, { error: 'Decision must be approve or deny.' });
          return true;
        }
        const oauthStore = await store();
        const authorization = request.method === 'POST'
          ? await oauthStore.consumeAuthorization(requestId)
          : await oauthStore.getAuthorization(requestId);
        if (!authorization) {
          writeJson(response, 404, { error: 'The authorization request is invalid or expired.' });
          return true;
        }
        const client = await oauthStore.getClient(authorization.clientId);
        if (!client) {
          writeJson(response, 404, { error: 'The OAuth client no longer exists.' });
          return true;
        }
        if (request.method === 'GET') {
          writeJson(response, 200, {
            clientName: client.client_name ?? 'ChatGPT',
            expiresAt: new Date(authorization.expiresAt).toISOString(),
            scopes: authorization.scopes
          });
          return true;
        }
        const redirect = new URL(authorization.redirectUri);
        if (body?.decision === 'deny') {
          redirect.searchParams.set('error', 'access_denied');
          redirect.searchParams.set('error_description', 'The user denied the Project Space connection.');
        } else if (body?.decision === 'approve') {
          const code = await oauthStore.createCredential({
            clientId: authorization.clientId,
            codeChallenge: authorization.codeChallenge,
            kind: 'authorization_code',
            redirectUri: authorization.redirectUri,
            resource: authorization.resource,
            scopes: authorization.scopes,
            userEmail: session.email,
            userId: session.userId
          });
          redirect.searchParams.set('code', code);
        }
        if (authorization.state) redirect.searchParams.set('state', authorization.state);
        writeJson(response, 200, { redirectUrl: redirect.toString() });
        return true;
      }

      if (!oauthPaths.has(url.pathname)) return false;
      const origin = requestPublicOrigin(request);
      return runExpressHandler(routerFor(origin), request, response);
    },
    verifyAccessToken(request: IncomingMessage, token: string) {
      return providerFor(requestPublicOrigin(request)).verifyAccessToken(token);
    }
  };
}
