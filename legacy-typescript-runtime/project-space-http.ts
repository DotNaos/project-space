import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { createLocalProjectSpaceBackend } from './local-project-space-backend';
import type {
  OpenPathInAppRequest,
  CodexOpenRequest,
  ProjectBackupRequest,
  GitCommitRequest,
  GitDiffRequest,
  GitStageRequest,
  ProjectDeployRequest,
  ProjectDirectorySelection,
  ProjectSpaceBackend,
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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

function writeEmpty(response: ServerResponse, statusCode = 204) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Allow-Origin': '*'
  });
  response.end();
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
  const server = createServer(createProjectSpaceRequestHandler(options));

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
