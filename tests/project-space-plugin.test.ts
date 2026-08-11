import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('Project Space Codex plugin', () => {
  test('is exposed through the repository marketplace', () => {
    const marketplace = readJson('.agents/plugins/marketplace.json');

    expect(marketplace).toMatchObject({
      interface: { displayName: 'Project Space' },
      name: 'project-space',
      plugins: [
        {
          category: 'Productivity',
          name: 'project-space',
          policy: {
            authentication: 'ON_INSTALL',
            installation: 'AVAILABLE',
          },
          source: {
            path: './plugins/project-space',
            source: 'local',
          },
        },
      ],
    });
  });

  test('uses the production MCP endpoint without duplicating its OAuth resource', () => {
    const manifest = readJson(
      'plugins/project-space/.codex-plugin/plugin.json',
    );
    const mcp = readJson('plugins/project-space/.mcp.json');

    expect(manifest).toMatchObject({
      mcpServers: './.mcp.json',
      name: 'project-space',
      skills: './skills/',
    });
    expect(mcp).toEqual({
      mcpServers: {
        'project-space': {
          type: 'http',
          url: 'https://projects.os-home.net/mcp',
        },
      },
    });
    expect(JSON.stringify(mcp)).not.toContain('oauth_resource');
  });

  test('routes account-wide work to MCP and local work to the Project CLI', () => {
    const skill = readFileSync(
      'plugins/project-space/skills/project-space-tools/SKILL.md',
      'utf8',
    );

    expect(skill).toContain('Use the Project Space MCP');
    expect(skill).toContain('Use the `project` CLI');
    expect(skill).toContain('project worktree');
    expect(skill).toContain('https://projects.os-home.net/mcp');
  });
});
