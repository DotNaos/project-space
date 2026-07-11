import { createReadStream, existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { writeJson } from './project-space-http-response';

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

export function serveProjectSpaceStatic(
  response: ServerResponse,
  staticRoot: string,
  pathname: string
) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const normalizedPath = normalize(decodeURIComponent(requestedPath)).replace(
    /^(\.\.[/\\])+/,
    ''
  );
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
