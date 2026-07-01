import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { createLocalProjectSpaceBackend } from './local-project-space-backend';
import { registerConnectorProjectRegistry } from './connector-hub';
import { createMachineTerminalUpgradeHandler } from './machine-terminal-websocket';
import {
  getProjectSpaceAuthSessionResult,
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest,
  readAuthTokenFromRequest,
  revokeProjectSpaceAuthSession,
  runWithAuthSession
} from './local-auth-store';
import type {
  ConnectorProjectRegistryResult,
  OpenPathInAppRequest,
  CodexOpenRequest,
  GitHubOAuthDevicePollRequest,
  MachineTerminalCommandRequest,
  ProjectBackupRequest,
  ProjectCliCommandRequest,
  GitCommitRequest,
  GitDiffRequest,
  GitStageRequest,
  ProjectDeployRequest,
  ProjectDirectorySelection,
  ProjectSpaceBackend,
  ScopeDevboxStartRequest,
  ProjectsState,
  TerminalCommandRequest,
  ToolLaunchRequest
} from '../src/shared/project-space-api';

interface ProjectSpaceHttpOptions {
  backend?: ProjectSpaceBackend;
  host?: string;
  port?: number;
  staticRoot?: string;
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

function writeEmpty(response: ServerResponse, statusCode = 204) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Allow-Origin': '*'
  });
  response.end();
}

function writeText(response: ServerResponse, statusCode: number, body: string, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Type': contentType
  });
  response.end(body);
}

function safeShellDoubleQuoted(value: string) {
  return value.replace(/["\\$`]/g, (match) => `\\${match}`);
}

function connectorInstallScript(origin: string, registrationToken?: string) {
  const registrationTokenValue = registrationToken
    ? safeShellDoubleQuoted(registrationToken)
    : '${PROJECT_CONNECTOR_REGISTRATION_TOKEN:-}';

  return `#!/usr/bin/env bash
set -euo pipefail

hub_url="${origin}"
registration_token="${registrationTokenValue}"
install_dir="\${PROJECT_SPACE_CONNECTOR_DIR:-$HOME/.local/bin}"
service_name="\${PROJECT_CONNECTOR_SERVICE_NAME:-$(hostname -s)}"
asset="project-space-connector-darwin-arm64.tar.gz"
download_url="https://github.com/DotNaos/project-space/releases/latest/download/$asset"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "Project Space currently publishes a packaged connector for macOS arm64."
  echo "For this machine, build from source or install a matching connector binary, then run:"
  echo "PROJECT_CONNECTOR_HUB_URL=$hub_url PROJECT_CONNECTOR_SERVICE_NAME=$service_name project-space-connector"
  exit 1
fi

mkdir -p "$install_dir"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

curl -fsSL "$download_url" -o "$tmp_dir/project-space-connector.tar.gz"
tar -xzf "$tmp_dir/project-space-connector.tar.gz" -C "$tmp_dir"
install "$tmp_dir/project-space-connector" "$install_dir/project-space-connector"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/net.os-home.project-space-connector.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>net.os-home.project-space-connector</string>
  <key>ProgramArguments</key>
  <array>
    <string>$install_dir/project-space-connector</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PROJECT_CONNECTOR_HUB_URL</key>
    <string>$hub_url</string>
    <key>PROJECT_CONNECTOR_SERVICE_NAME</key>
    <string>$service_name</string>
    <key>PROJECT_CONNECTOR_REGISTRATION_TOKEN</key>
    <string>$registration_token</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
PLIST

launchctl unload "$HOME/Library/LaunchAgents/net.os-home.project-space-connector.plist" >/dev/null 2>&1 || true
launchctl load "$HOME/Library/LaunchAgents/net.os-home.project-space-connector.plist"

echo "Project Space connector installed."
echo "Machine service: $service_name"
echo "Hub: $hub_url"
`;
}

function requestPublicOrigin(request: IncomingMessage) {
  const host = request.headers['x-forwarded-host'] ?? request.headers.host ?? 'projects.os-home.net';
  const proto = request.headers['x-forwarded-proto'] ?? (String(host).includes('127.0.0.1') ? 'http' : 'https');
  const firstHost = Array.isArray(host) ? host[0] : String(host).split(',')[0]?.trim();
  const firstProto = Array.isArray(proto) ? proto[0] : String(proto).split(',')[0]?.trim();

  return `${firstProto || 'https'}://${firstHost || 'projects.os-home.net'}`;
}

function connectorRegistrationToken() {
  return process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN ?? '';
}

function requestConnectorToken(request: IncomingMessage) {
  const headerToken = request.headers['x-project-connector-token'];
  const authHeader = request.headers.authorization;

  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }

  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice('bearer '.length).trim();
  }

  return '';
}

function hasValidConnectorRegistrationToken(request: IncomingMessage) {
  const expected = connectorRegistrationToken();
  const actual = requestConnectorToken(request);

  if (!expected || !actual) {
    return false;
  }

  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);

  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function connectorInstallUrl(origin: string) {
  const token = connectorRegistrationToken();
  const url = new URL('/connector/install.sh', origin);

  if (token) {
    url.searchParams.set('registrationToken', token);
  }

  return url.toString();
}

function connectorInstallCommand(origin: string) {
  return `curl -fsSL ${connectorInstallUrl(origin)} | bash`;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf-8').trim();

  return (body ? JSON.parse(body) : {}) as T;
}

function createApiHandler(backend: ProjectSpaceBackend) {
  return async function handleApiRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    try {
      if (request.method === 'OPTIONS') {
        writeEmpty(response);
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        writeJson(response, 200, { ok: true });
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/app/meta') {
        writeJson(response, 200, await backend.getAppMeta());
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/auth/session') {
        writeJson(
          response,
          200,
          await getProjectSpaceAuthSessionResult(readAuthTokenFromRequest(request))
        );
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        revokeProjectSpaceAuthSession();
        writeJson(response, 200, { ok: true });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/connectors/project-registry') {
        if (!hasValidConnectorRegistrationToken(request)) {
          writeJson(response, 401, { error: 'Connector registration token required.' });
          return true;
        }

        const payload = await readJson<ConnectorProjectRegistryResult>(request);
        registerConnectorProjectRegistry(payload);
        writeJson(response, 200, { ok: true });
        return true;
      }

      const authSession = await readAuthSessionFromRequest(request);

      if (isProjectSpaceAuthRequired() && !authSession) {
        writeJson(response, 401, { error: 'Login required.' });
        return true;
      }

      return await runWithAuthSession(authSession, async () => {
      if (request.method === 'GET' && url.pathname === '/api/connectors/install-command') {
        const origin = requestPublicOrigin(request);

        writeJson(response, 200, {
          command: connectorInstallCommand(origin),
          scriptUrl: connectorInstallUrl(origin)
        });
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/launcher/apps') {
        writeJson(response, 200, await backend.loadLauncherApps());
        return true;
      }

      const iconMatch = url.pathname.match(/^\/api\/launcher\/apps\/([^/]+)\/icon$/);
      if (request.method === 'GET' && iconMatch?.[1]) {
        writeJson(response, 200, {
          iconDataUrl: await backend.loadLauncherAppIcon(decodeURIComponent(iconMatch[1]))
        });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/launcher/open-path') {
        const payload = await readJson<OpenPathInAppRequest>(request);
        writeJson(response, 200, await backend.openPathInApp(payload));
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/projects/discovery') {
        writeJson(response, 200, await backend.loadProjectDiscovery());
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/projects/state') {
        writeJson(response, 200, await backend.loadProjectsState());
        return true;
      }

      if (request.method === 'PUT' && url.pathname === '/api/projects/state') {
        await backend.saveProjectsState(await readJson<ProjectsState>(request));
        writeJson(response, 200, {});
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/projects/worktrees') {
        const projectPath = url.searchParams.get('projectPath');

        if (!projectPath) {
          writeJson(response, 400, { error: 'Missing projectPath.' });
          return true;
        }

        writeJson(response, 200, await backend.loadProjectWorktrees(projectPath));
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/projectctl/overview') {
        const projectPath = url.searchParams.get('projectPath');

        if (!projectPath) {
          writeJson(response, 400, { error: 'Missing projectPath.' });
          return true;
        }

        writeJson(response, 200, await backend.loadProjectctlOverview(projectPath));
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/projectctl/preview') {
        const projectPath = url.searchParams.get('projectPath');

        if (!projectPath) {
          writeJson(response, 400, { error: 'Missing projectPath.' });
          return true;
        }

        writeJson(response, 200, await backend.loadProjectctlPreview(projectPath));
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/projects/select-directory') {
        const selection: ProjectDirectorySelection = await backend.selectProjectDirectory();
        writeJson(response, 200, selection);
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/filesystem/directory') {
        const path = url.searchParams.get('path');

        if (!path) {
          writeJson(response, 400, { error: 'Missing path.' });
          return true;
        }

        writeJson(response, 200, await backend.readDirectory(path));
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/codex/open-skills') {
        writeJson(response, 200, await backend.openCodexSkills());
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/codex/status') {
        writeJson(response, 200, await backend.getCodexStatus());
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/connectors/overview') {
        writeJson(response, 200, await backend.getConnectorOverview());
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/connectors/project-registry') {
        writeJson(response, 200, await backend.getConnectorProjectRegistry());
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/connectors/project-registry') {
        const payload = await readJson<ConnectorProjectRegistryResult>(request);
        registerConnectorProjectRegistry(payload);
        writeJson(response, 200, { ok: true });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/project-cli/run') {
        const payload = await readJson<ProjectCliCommandRequest>(request);
        writeJson(response, 200, await backend.runProjectCliCommand(payload));
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/github/catalog') {
        writeJson(response, 200, await backend.getGitHubCatalog());
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/github/repository-details') {
        const fullName = url.searchParams.get('fullName');

        if (!fullName) {
          writeJson(response, 400, { error: 'Missing fullName.' });
          return true;
        }

        writeJson(response, 200, await backend.getGitHubRepositoryDetails(fullName));
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/github/oauth/device/start') {
        writeJson(response, 200, await backend.startGitHubOAuthDeviceFlow());
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/github/oauth/device/poll') {
        const payload = await readJson<GitHubOAuthDevicePollRequest>(request);
        writeJson(response, 200, await backend.pollGitHubOAuthDeviceFlow(payload));
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/platform/overview') {
        writeJson(response, 200, await backend.getPlatformOverview());
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/platform/deploy-project') {
        const payload = await readJson<ProjectDeployRequest>(request);
        writeJson(response, 200, await backend.deployProject(payload));
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/platform/backup-project') {
        const payload = await readJson<ProjectBackupRequest>(request);
        writeJson(response, 200, await backend.backupProject(payload));
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/codex/open-target') {
        const payload = await readJson<CodexOpenRequest>(request);
        writeJson(response, 200, await backend.openCodexTarget(payload));
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/terminal/run') {
        const payload = await readJson<TerminalCommandRequest>(request);
        writeJson(response, 200, await backend.runTerminalCommand(payload));
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/machines/terminal/run') {
        const payload = await readJson<MachineTerminalCommandRequest>(request);
        writeJson(response, 200, await backend.runMachineTerminalCommand(payload));
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/scope-devbox/overview') {
        writeJson(response, 200, await backend.getScopeDevboxOverview());
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/scope-devbox/jobs') {
        const payload = await readJson<ScopeDevboxStartRequest>(request);
        writeJson(response, 200, await backend.startScopeDevboxJob(payload));
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/git/status') {
        const cwd = url.searchParams.get('cwd');

        if (!cwd) {
          writeJson(response, 400, { error: 'Missing cwd.' });
          return true;
        }

        writeJson(response, 200, await backend.getGitStatus(cwd));
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/git/diff') {
        const payload = await readJson<GitDiffRequest>(request);
        writeJson(response, 200, await backend.getGitDiff(payload));
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/git/stage') {
        const payload = await readJson<GitStageRequest>(request);
        writeJson(response, 200, await backend.stageGitPaths(payload));
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/git/unstage') {
        const payload = await readJson<GitStageRequest>(request);
        writeJson(response, 200, await backend.unstageGitPaths(payload));
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/git/commit') {
        const payload = await readJson<GitCommitRequest>(request);
        writeJson(response, 200, await backend.commitGitChanges(payload));
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/workspace-tool/open') {
        const payload = await readJson<ToolLaunchRequest>(request);
        writeJson(response, 200, await backend.openWorkspaceTool(payload));
        return true;
      }

      return false;
      });
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : 'Unexpected backend error.'
      });
      return true;
    }
  };
}

function serveStatic(response: ServerResponse, staticRoot: string, pathname: string) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const normalizedPath = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, '');
  const filePath = resolve(join(staticRoot, normalizedPath));
  const rootPath = resolve(staticRoot);
  const fallbackPath = join(rootPath, 'index.html');
  const targetPath =
    filePath.startsWith(rootPath) && existsSync(filePath) && statSync(filePath).isFile()
      ? filePath
      : fallbackPath;

  if (!existsSync(targetPath)) {
    writeJson(response, 404, { error: 'Not found.' });
    return;
  }

  response.writeHead(200, {
    'Content-Type': contentTypes[extname(targetPath)] ?? 'application/octet-stream'
  });
  createReadStream(targetPath).pipe(response);
}

export function createProjectSpaceRequestHandler(options: ProjectSpaceHttpOptions = {}) {
  const backend = options.backend ?? createLocalProjectSpaceBackend();
  const handleApiRequest = createApiHandler(backend);

  return async function handleProjectSpaceRequest(
    request: IncomingMessage,
    response: ServerResponse
  ) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/connector/install.sh') {
      writeText(
        response,
        200,
        connectorInstallScript(
          requestPublicOrigin(request),
          url.searchParams.get('registrationToken') ?? undefined
        ),
        'text/x-shellscript; charset=utf-8'
      );
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApiRequest(request, response, url);

      if (!handled) {
        writeJson(response, 404, { error: 'Route not found.' });
      }

      return;
    }

    if (options.staticRoot) {
      serveStatic(response, options.staticRoot, url.pathname);
      return;
    }

    writeJson(response, 404, { error: 'Route not found.' });
  };
}

export async function createProjectSpaceServer(options: ProjectSpaceHttpOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const backend = options.backend ?? createLocalProjectSpaceBackend();
  const server = createServer(createProjectSpaceRequestHandler({
    ...options,
    backend
  }));
  const handleMachineTerminalUpgrade = createMachineTerminalUpgradeHandler(backend);

  server.on('upgrade', (request, socket, head) => {
    if (!handleMachineTerminalUpgrade(request, socket, head)) {
      socket.destroy();
    }
  });

  await new Promise<void>((resolveListen) => {
    server.listen(options.port ?? 0, host, resolveListen);
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Project Space backend did not expose a TCP address.');
  }

  return {
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }

          resolveClose();
        });
      }),
    origin: `http://${host}:${address.port}`,
    server
  };
}
