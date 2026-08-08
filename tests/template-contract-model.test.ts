import { describe, expect, test } from 'bun:test';
import {
  parseTemplateManifest,
  parseTemplateModule,
  resolveTemplateModulePath,
  templateRuleKindSummary
} from '../src/features/project-template/template-contract-model';
import { buildGitHubTreeNodes } from '../src/shared/github-repository-tree';

const manifestSource = `# yaml-language-server: $schema=../schema/template-manifest.schema.json
name: project-template
version: 0.1.0
modules:
  - modules/core.fullstack.yaml
`;

const moduleSource = `name: core.fullstack
description: Runnable fullstack foundation.
default: true
values:
  project.slug:
    type: string
    required: true
    pattern: "^[a-z0-9-]+$"
    description: URL safe project slug.
  project.displayName:
    type: string
    defaultFrom: project.slug
    transform: title
rules:
  package.json:
    format: json
    entries:
      - path: /name
        kind: slot
        pattern: "^[a-z0-9-]+$"
      - path: /private
        kind: frozen
      - path: /scripts/*
        kind: open
      - path: /dependencies/*
        kind: deny
owns:
  - package.json
  - src/**/*
`;

describe('parseTemplateManifest', () => {
  test('reads the name, version, and module list', () => {
    expect(parseTemplateManifest(manifestSource)).toEqual({
      modulePaths: ['modules/core.fullstack.yaml'],
      name: 'project-template',
      version: '0.1.0'
    });
  });

  test('rejects a manifest without a name', () => {
    expect(parseTemplateManifest('version: 1.0.0')).toBeUndefined();
  });

  test('rejects source that is not YAML mapping', () => {
    expect(parseTemplateManifest('- a\n- b')).toBeUndefined();
    expect(parseTemplateManifest('name: [unclosed')).toBeUndefined();
  });
});

describe('resolveTemplateModulePath', () => {
  test('resolves against the manifest directory', () => {
    expect(resolveTemplateModulePath('template/manifest.yaml', 'modules/core.yaml'))
      .toBe('template/modules/core.yaml');
  });

  test('walks out of the manifest directory', () => {
    expect(resolveTemplateModulePath('template/manifest.yaml', '../shared/core.yaml'))
      .toBe('shared/core.yaml');
  });

  test('treats a leading slash as repository absolute', () => {
    expect(resolveTemplateModulePath('template/manifest.yaml', '/modules/core.yaml'))
      .toBe('modules/core.yaml');
  });
});

describe('parseTemplateModule', () => {
  const module = parseTemplateModule(moduleSource, 'template/modules/core.fullstack.yaml')!;

  test('reads the module identity', () => {
    expect(module.name).toBe('core.fullstack');
    expect(module.isDefault).toBe(true);
    expect(module.sourcePath).toBe('template/modules/core.fullstack.yaml');
  });

  test('reads values with their requirements and defaults', () => {
    const bySlug = new Map(module.values.map((value) => [value.name, value]));
    expect(bySlug.get('project.slug')).toMatchObject({
      description: 'URL safe project slug.',
      pattern: '^[a-z0-9-]+$',
      required: true,
      type: 'string'
    });
    expect(bySlug.get('project.displayName')).toMatchObject({
      defaultFrom: 'project.slug',
      required: false,
      transform: 'title'
    });
  });

  test('reads file rules and their entry kinds', () => {
    expect(module.rules).toHaveLength(1);
    expect(module.rules[0].file).toBe('package.json');
    expect(module.rules[0].format).toBe('json');
    expect(module.rules[0].entries.map((entry) => entry.kind))
      .toEqual(['slot', 'frozen', 'open', 'deny']);
  });

  test('reads the owned paths', () => {
    expect(module.owns).toEqual(['package.json', 'src/**/*']);
  });

  test('marks an unknown rule kind instead of dropping the entry', () => {
    const unknown = parseTemplateModule(
      'name: m\nrules:\n  a.json:\n    entries:\n      - path: /x\n        kind: sideways\n',
      'm.yaml'
    )!;
    expect(unknown.rules[0].entries[0].kind).toBe('unknown');
  });

  test('rejects a module without a name', () => {
    expect(parseTemplateModule('description: no name', 'm.yaml')).toBeUndefined();
  });
});

describe('templateRuleKindSummary', () => {
  test('counts entries per kind, most frequent first', () => {
    const module = parseTemplateModule(
      'name: m\nrules:\n  a.json:\n    entries:\n      - path: /a\n        kind: frozen\n      - path: /b\n        kind: frozen\n      - path: /c\n        kind: slot\n',
      'm.yaml'
    )!;
    expect(templateRuleKindSummary(module)).toEqual([
      { count: 2, kind: 'frozen' },
      { count: 1, kind: 'slot' }
    ]);
  });
});

describe('buildGitHubTreeNodes', () => {
  test('nests blobs under their directories with folders first', () => {
    const nodes = buildGitHubTreeNodes([
      { path: 'README.md', sha: '1', type: 'blob' },
      { path: 'template', sha: '2', type: 'tree' },
      { path: 'template/manifest.yaml', sha: '3', type: 'blob' },
      { path: 'template/modules', sha: '4', type: 'tree' },
      { path: 'template/modules/core.yaml', sha: '5', type: 'blob' }
    ]);

    expect(nodes.map((node) => node.name)).toEqual(['template', 'README.md']);
    expect(nodes[0].children.map((node) => node.name)).toEqual(['modules', 'manifest.yaml']);
    expect(nodes[0].children[0].children.map((node) => node.name)).toEqual(['core.yaml']);
  });

  test('drops an entry whose parent the truncated tree omitted', () => {
    const nodes = buildGitHubTreeNodes([
      { path: 'a/b/c.txt', sha: '1', type: 'blob' }
    ]);

    expect(nodes).toEqual([]);
  });
});
