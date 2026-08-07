import { parse } from 'yaml';

export const projectTemplateRepository = 'DotNaos/project-template';
export const projectTemplateManifestPath = 'template/manifest.yaml';

export type TemplateRuleKind = 'deny' | 'frozen' | 'open' | 'slot' | 'unknown';

export interface TemplateValue {
  default?: string;
  defaultFrom?: string;
  description?: string;
  name: string;
  pattern?: string;
  required: boolean;
  transform?: string;
  type: string;
}

export interface TemplateRuleEntry {
  kind: TemplateRuleKind;
  path: string;
  pattern?: string;
}

export interface TemplateFileRule {
  entries: TemplateRuleEntry[];
  file: string;
  format?: string;
}

export interface TemplateModule {
  description?: string;
  isDefault: boolean;
  name: string;
  owns: string[];
  rules: TemplateFileRule[];
  /** Repository path the module was read from. */
  sourcePath: string;
  values: TemplateValue[];
}

export interface TemplateManifest {
  modulePaths: string[];
  name: string;
  version?: string;
}

const ruleKinds = new Set<TemplateRuleKind>(['deny', 'frozen', 'open', 'slot']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const entryText = text(entry);
    return entryText ? [entryText] : [];
  }) : [];
}

/**
 * Module paths in the manifest are relative to the manifest itself, so they are
 * resolved against its directory rather than the repository root.
 */
export function resolveTemplateModulePath(manifestPath: string, modulePath: string) {
  if (modulePath.startsWith('/')) return modulePath.slice(1);
  const directory = manifestPath.split('/').slice(0, -1);
  const segments = [...directory, ...modulePath.split('/')];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join('/');
}

export function parseTemplateManifest(source: string): TemplateManifest | undefined {
  let document: unknown;
  try {
    document = parse(source);
  } catch {
    return undefined;
  }
  if (!isRecord(document)) return undefined;
  const name = text(document.name);
  if (!name) return undefined;
  return {
    modulePaths: stringList(document.modules),
    name,
    ...(text(document.version) ? { version: text(document.version) } : {})
  };
}

function parseValues(value: unknown): TemplateValue[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([name, raw]) => {
    if (!isRecord(raw)) return [];
    return [{
      ...(text(raw.default) ? { default: text(raw.default) } : {}),
      ...(text(raw.defaultFrom) ? { defaultFrom: text(raw.defaultFrom) } : {}),
      ...(text(raw.description) ? { description: text(raw.description) } : {}),
      name,
      ...(text(raw.pattern) ? { pattern: text(raw.pattern) } : {}),
      required: raw.required === true,
      ...(text(raw.transform) ? { transform: text(raw.transform) } : {}),
      type: text(raw.type) ?? 'unknown'
    }];
  });
}

function parseRules(value: unknown): TemplateFileRule[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([file, raw]) => {
    if (!isRecord(raw)) return [];
    const entries = Array.isArray(raw.entries) ? raw.entries.flatMap<TemplateRuleEntry>((entry) => {
      if (!isRecord(entry)) return [];
      const path = text(entry.path);
      if (!path) return [];
      const kind = text(entry.kind) as TemplateRuleKind | undefined;
      return [{
        kind: kind && ruleKinds.has(kind) ? kind : 'unknown',
        path,
        ...(text(entry.pattern) ? { pattern: text(entry.pattern) } : {})
      }];
    }) : [];
    return [{
      entries,
      file,
      ...(text(raw.format) ? { format: text(raw.format) } : {})
    }];
  });
}

export function parseTemplateModule(
  source: string,
  sourcePath: string
): TemplateModule | undefined {
  let document: unknown;
  try {
    document = parse(source);
  } catch {
    return undefined;
  }
  if (!isRecord(document)) return undefined;
  const name = text(document.name);
  if (!name) return undefined;
  return {
    ...(text(document.description) ? { description: text(document.description) } : {}),
    isDefault: document.default === true,
    name,
    owns: stringList(document.owns),
    rules: parseRules(document.rules),
    sourcePath,
    values: parseValues(document.values)
  };
}

export interface TemplateRuleKindSummary {
  count: number;
  kind: TemplateRuleKind;
}

/** How many entries a module pins, opens, or forbids, for the contract header. */
export function templateRuleKindSummary(module: TemplateModule): TemplateRuleKindSummary[] {
  const counts = new Map<TemplateRuleKind, number>();
  for (const rule of module.rules) {
    for (const entry of rule.entries) {
      counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ count, kind }))
    .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind));
}

export function templateRuleKindDescription(kind: TemplateRuleKind) {
  if (kind === 'slot') return 'Filled per project from a template value';
  if (kind === 'frozen') return 'Must match the template exactly';
  if (kind === 'open') return 'The project owns this freely';
  if (kind === 'deny') return 'The project must not set this';
  return 'Not described by the template schema';
}
