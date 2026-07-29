import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const dockerfilePath = new URL('../deploy/preview.prototype.Dockerfile', import.meta.url);
const nginxPath = new URL('../deploy/preview.prototype.nginx.conf', import.meta.url);
const composePath = new URL('../deploy/preview.compose.yml', import.meta.url);

describe('trusted PR prototype deployment', () => {
  test('builds exact PR source but runs only static output with trusted configuration', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8');
    const runtime = dockerfile.slice(dockerfile.indexOf('FROM nginxinc/nginx-unprivileged'));

    expect(dockerfile).toContain("grep -Eq '^[0-9a-f]{40}$'");
    expect(dockerfile).toContain('--base /prototype/desktop/');
    expect(dockerfile).toContain('/workspace/apps/prototype/dist');
    expect(dockerfile).toContain('bun run build:prototype');
    expect(dockerfile).toContain('/workspace/apps/mobile/dist-prototype');
    expect(dockerfile).toContain(
      '"surfaces":["mobile-prototype","desktop-prototype"]'
    );
    expect(runtime).toContain('nginxinc/nginx-unprivileged:1.27-alpine@sha256:');
    expect(runtime).toContain(
      'COPY --from=trusted-assets deploy/preview.prototype.nginx.conf'
    );
    expect(runtime).not.toContain('COPY . .');
    expect(runtime).not.toContain('/workspace/server');
    expect(runtime).not.toContain('PROJECT_SPACE_PREVIEW_GATEWAY_SECRET');
  });

  test('serves only fixed prototype namespaces with a network-denying CSP', async () => {
    const nginx = await readFile(nginxPath, 'utf8');

    expect(nginx).toContain('location = /prototype/meta.json');
    expect(nginx).toContain('location = /prototype/desktop');
    expect(nginx).toContain('location /prototype/desktop/');
    expect(nginx).toContain('try_files $uri $uri/ /prototype/desktop/index.html');
    expect(nginx).toContain('location = /prototype/mobile');
    expect(nginx).toContain('location /prototype/mobile/');
    expect(nginx).toContain('try_files $uri $uri/ /prototype/mobile/index.html');
    expect(nginx).toContain("connect-src 'none'");
    expect(nginx).toContain("frame-src 'none'");
    expect(nginx).toContain('location / {\n    return 404;');
  });

  test('keeps the static service credential-free and disabled until the runner accepts its digest', async () => {
    const compose = await readFile(composePath, 'utf8');
    const prototype = compose.slice(
      compose.indexOf('  prototype:'),
      compose.indexOf('\n  db:')
    );

    expect(prototype).toContain('profiles: [prototype]');
    expect(prototype).toContain('PREVIEW_PROTOTYPE_IMAGE');
    expect(prototype).toContain('aliases: [preview-prototype]');
    expect(prototype).toContain('/prototype/meta.json');
    expect(prototype).not.toContain('env_file:');
    expect(prototype).not.toContain('environment:');
    expect(prototype).not.toContain('volumes:');
    expect(prototype).not.toContain('DATABASE_URL');
    expect(compose).toContain(
      'PROJECT_SPACE_PREVIEW_PROTOTYPE_UPSTREAM_ORIGIN: ${PREVIEW_PROTOTYPE_UPSTREAM_ORIGIN:-}'
    );
  });
});
