import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.AUTH_SERVER_PORT ?? 8787);
const authServerOrigin =
  process.env.AUTH_SERVER_ORIGIN ?? `http://127.0.0.1:${port}`;
const clientId = process.env.GITHUB_CLIENT_ID ?? '';
const clientSecret = process.env.GITHUB_CLIENT_SECRET ?? '';

const pendingRequests = new Map();
const issuedSessions = new Map();

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function base64Url(input) {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function buildCodeChallenge(codeVerifier) {
  return base64Url(createHash('sha256').update(codeVerifier).digest());
}

function createState() {
  return base64Url(randomBytes(24));
}

function cleanupMaps() {
  const now = Date.now();

  for (const [key, value] of pendingRequests.entries()) {
    if (now - value.createdAt > 10 * 60 * 1000) {
      pendingRequests.delete(key);
    }
  }

  for (const [key, value] of issuedSessions.entries()) {
    if (now - value.createdAt > 5 * 60 * 1000) {
      issuedSessions.delete(key);
    }
  }
}

async function exchangeCodeForToken({ code, codeVerifier, redirectUri }) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });

  const payload = await response.json();

  if (!response.ok || payload.error) {
    throw new Error(payload.error_description ?? 'GitHub token exchange failed.');
  }

  return payload.access_token;
}

async function fetchViewer(accessToken) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error('GitHub user lookup failed.');
  }

  const payload = await response.json();

  return {
    login: payload.login,
    name: payload.name,
    avatarUrl: payload.avatar_url,
  };
}

function withQueryValue(urlString, key, value) {
  const url = new URL(urlString);
  url.searchParams.set(key, value);
  return url.toString();
}

const server = createServer(async (request, response) => {
  cleanupMaps();

  if (!request.url) {
    json(response, 400, { error: 'Missing request URL.' });
    return;
  }

  const url = new URL(request.url, authServerOrigin);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    response.end();
    return;
  }

  if (url.pathname === '/health') {
    json(response, 200, {
      ok: true,
      configured: Boolean(clientId && clientSecret),
      callbackUrl: `${authServerOrigin}/auth/github/callback`,
    });
    return;
  }

  if (url.pathname === '/auth/github/start') {
    const returnTo = url.searchParams.get('returnTo');

    if (!clientId || !clientSecret) {
      json(response, 500, {
        error: 'GitHub OAuth environment variables are missing.',
      });
      return;
    }

    if (!returnTo) {
      json(response, 400, { error: 'Missing returnTo URL.' });
      return;
    }

    const state = createState();
    const codeVerifier = createState() + createState();
    const redirectUri = `${authServerOrigin}/auth/github/callback`;

    pendingRequests.set(state, {
      codeVerifier,
      returnTo,
      createdAt: Date.now(),
    });

    const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', 'read:user repo');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', buildCodeChallenge(codeVerifier));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('prompt', 'select_account');

    redirect(response, authorizeUrl.toString());
    return;
  }

  if (url.pathname === '/auth/github/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (!state || !pendingRequests.has(state)) {
      json(response, 400, { error: 'OAuth state is missing or expired.' });
      return;
    }

    const pendingRequest = pendingRequests.get(state);
    pendingRequests.delete(state);

    if (error) {
      redirect(
        response,
        withQueryValue(
          pendingRequest.returnTo,
          'oauth_error',
          url.searchParams.get('error_description') ?? error
        )
      );
      return;
    }

    if (!code) {
      redirect(
        response,
        withQueryValue(
          pendingRequest.returnTo,
          'oauth_error',
          'GitHub did not return a code.'
        )
      );
      return;
    }

    try {
      const accessToken = await exchangeCodeForToken({
        code,
        codeVerifier: pendingRequest.codeVerifier,
        redirectUri: `${authServerOrigin}/auth/github/callback`,
      });
      const viewer = await fetchViewer(accessToken);
      const sessionId = createState();

      issuedSessions.set(sessionId, {
        accessToken,
        viewer,
        createdAt: Date.now(),
      });

      redirect(
        response,
        withQueryValue(pendingRequest.returnTo, 'oauth_session', sessionId)
      );
    } catch (exchangeError) {
      redirect(
        response,
        withQueryValue(
          pendingRequest.returnTo,
          'oauth_error',
          exchangeError instanceof Error
            ? exchangeError.message
            : 'GitHub login failed.'
        )
      );
    }
    return;
  }

  if (url.pathname === '/auth/github/session') {
    const sessionId = url.searchParams.get('id');

    if (!sessionId || !issuedSessions.has(sessionId)) {
      json(response, 404, { error: 'OAuth session was not found.' });
      return;
    }

    const session = issuedSessions.get(sessionId);
    issuedSessions.delete(sessionId);
    json(response, 200, session);
    return;
  }

  json(response, 404, { error: 'Route not found.' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`GitHub auth server running on ${authServerOrigin}`);
});
