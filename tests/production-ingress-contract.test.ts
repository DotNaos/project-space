import { describe, expect, test } from 'bun:test';
interface RenderedCompose {
  services?: Record<string, { labels?: Record<string, string> }>;
}

function renderProductionWebLabels() {
  const result = Bun.spawnSync({
    cmd: [
      'docker', 'compose', '-p', 'project-space-prod',
      '-f', 'deploy/compose.yml', '-f', 'deploy/ingress.labels.yml',
      'config', '--format', 'json'
    ],
    env: {
      ...process.env,
      PROJECT_API_DOMAIN: 'api.projects.os-home.net',
      PROJECT_COMPOSE_NAME: 'project-space-prod',
      PROJECT_DOMAIN: 'projects.os-home.net',
      PROJECT_PREVIEW_HOST_SUFFIX: 'projects.os-home.net',
      PROJECT_PREVIEW_HOST_TLS_DOMAIN: 'projects.os-home.net',
      PROJECT_PREVIEW_HUB_DOMAIN: 'pr.projects.os-home.net'
    },
    stderr: 'pipe',
    stdout: 'pipe'
  });
  expect(result.exitCode).toBe(0);
  const compose = JSON.parse(result.stdout.toString()) as RenderedCompose;
  const labels = compose.services?.web?.labels;
  expect(labels).toBeDefined();
  return labels ?? {};
}

describe('Production ingress contract', () => {
  test('all web-container routers use the single explicit web service', () => {
    const labels = renderProductionWebLabels();
    const serviceIdentities = new Set(
      Object.keys(labels)
        .filter((key) => key.startsWith('traefik.http.services.'))
        .map((key) => key.split('.')[3])
    );
    expect(serviceIdentities).toEqual(new Set(['project-space-prod-web']));

    for (const router of ['web', 'preview-host', 'api']) {
      expect(labels[`traefik.http.routers.project-space-prod-${router}.service`])
        .toBe('project-space-prod-web');
    }
  });
});
