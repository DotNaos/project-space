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

function normalizeLabelKeys(labels: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(labels).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function traefikHttpServiceIdentities(labels: Record<string, string>) {
  return new Set(
    Object.keys(normalizeLabelKeys(labels))
      .filter((key) => key.startsWith('traefik.http.services.'))
      .map((key) => key.split('.')[3])
  );
}

describe('Production ingress contract', () => {
  test('all web-container routers use the single explicit web service', () => {
    const labels = renderProductionWebLabels();
    const normalizedLabels = normalizeLabelKeys(labels);
    expect(traefikHttpServiceIdentities(labels))
      .toEqual(new Set(['project-space-prod-web']));

    for (const router of ['web', 'preview-host', 'api']) {
      expect(normalizedLabels[`traefik.http.routers.project-space-prod-${router}.service`])
        .toBe('project-space-prod-web');
    }
  });

  test('counts differently cased Traefik service labels', () => {
    expect(traefikHttpServiceIdentities({
      'traefik.http.services.project-space-prod-web.loadbalancer.server.port': '4173',
      'Traefik.HTTP.Services.other.LoadBalancer.Server.URL': 'http://127.0.0.1:9999'
    })).toEqual(new Set(['project-space-prod-web', 'other']));
  });
});
