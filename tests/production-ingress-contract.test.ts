import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const ingress = readFileSync(new URL('../deploy/ingress.labels.yml', import.meta.url), 'utf8');

describe('Production ingress contract', () => {
  test('all web-container routers use the single explicit web service', () => {
    for (const router of ['web', 'preview-host', 'api']) {
      expect(ingress).toContain(
        `traefik.http.routers.\${PROJECT_COMPOSE_NAME}-${router}.service=\${PROJECT_COMPOSE_NAME}-web`
      );
    }

    const servicePorts = ingress.match(
      /traefik\.http\.services\.\$\{PROJECT_COMPOSE_NAME\}-[^\s]+\.loadbalancer\.server\.port=4173/g
    );
    expect(servicePorts).toEqual([
      'traefik.http.services.${PROJECT_COMPOSE_NAME}-web.loadbalancer.server.port=4173'
    ]);
  });
});
