import { parseStableSemver } from './semver';
import {
  releaseAreas,
  releaseBumps,
  type ReleaseArea,
  type ReleaseBump,
  type ReleaseUpgrade,
} from './types';

const frontmatterKeys = new Set([
  'title',
  'version',
  'bump',
  'pullRequest',
  'issues',
  'areas',
  'breaking',
  'upgrade',
]);

interface ParsedFrontmatter {
  areas?: unknown;
  breaking?: unknown;
  bump?: unknown;
  issues?: unknown;
  pullRequest?: unknown;
  title?: unknown;
  upgrade?: unknown;
  version?: unknown;
}

export interface ReleaseEntryMetadata {
  areas: ReleaseArea[];
  breaking: boolean;
  bump: ReleaseBump;
  issues: number[];
  pullRequest: number;
  title: string;
  upgrade: ReleaseUpgrade;
  version: string;
}

export function parseReleaseFrontmatter(
  source: string,
  fileName: string,
  errors: string[],
): ReleaseEntryMetadata | undefined {
  const result: Record<string, unknown> = {};
  const lines = source.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const keyMatch = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(
      line,
    );
    if (!keyMatch) {
      errors.push(
        `Frontmatter line ${index + 1} must be a top-level key or an indented list item.`,
      );
      continue;
    }
    const [, key, rawValue = ''] = keyMatch;
    if (!frontmatterKeys.has(key)) {
      errors.push(`Frontmatter field "${key}" is not allowed.`);
      continue;
    }
    if (Object.hasOwn(result, key)) {
      errors.push(`Frontmatter field "${key}" may appear only once.`);
      continue;
    }

    if (rawValue.trim()) {
      result[key] = parseScalar(rawValue.trim(), key, errors);
      continue;
    }
    const values: unknown[] = [];
    while (
      index + 1 < lines.length &&
      /^\s+-\s+/.test(lines[index + 1])
    ) {
      index += 1;
      const item = lines[index].replace(/^\s+-\s+/, '').trim();
      values.push(parseScalar(item, key, errors));
    }
    result[key] = values;
  }

  return validateFrontmatter(result, fileName, errors);
}

function parseScalar(
  raw: string,
  key: string,
  errors: string[],
): unknown {
  if (raw === '[]') return [];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^(0|[1-9]\d*)$/.test(raw)) return Number(raw);
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    const value = raw.slice(1, -1);
    if (/[\n\r]/.test(value)) {
      errors.push(`Frontmatter field "${key}" contains an invalid newline.`);
    }
    return value;
  }
  if (/^[A-Za-z0-9._/-]+$/.test(raw)) return raw;
  errors.push(
    `Frontmatter field "${key}" must use a string, integer, boolean, or indented list.`,
  );
  return undefined;
}

function validateFrontmatter(
  value: ParsedFrontmatter,
  fileName: string,
  errors: string[],
): ReleaseEntryMetadata | undefined {
  const title = requiredString(value.title, 'title', errors);
  const version = requiredString(value.version, 'version', errors);
  const bump = requiredEnum(
    value.bump,
    releaseBumps,
    'bump',
    errors,
  );
  const pullRequest = positiveInteger(
    value.pullRequest,
    'pullRequest',
    errors,
  );
  const issues = integerList(value.issues, 'issues', errors);
  const areas = enumList(
    value.areas,
    releaseAreas,
    'areas',
    errors,
  );
  const breaking =
    typeof value.breaking === 'boolean'
      ? value.breaking
      : undefined;
  const upgrade = requiredEnum(
    value.upgrade,
    ['none', 'required'] as const,
    'upgrade',
    errors,
  );

  if (breaking === undefined) {
    errors.push('Frontmatter field "breaking" must be an explicit boolean.');
  }
  if (title && (title.length < 4 || title.length > 100)) {
    errors.push('Frontmatter field "title" must contain 4 to 100 characters.');
  }
  if (version && !parseStableSemver(version)) {
    errors.push(
      'Frontmatter field "version" must be stable Semantic Versioning such as 0.4.43.',
    );
  }
  if (pullRequest && fileName !== `${pullRequest}.mdx`) {
    errors.push(
      `Release filename "${fileName}" must match pullRequest ${pullRequest} as "${pullRequest}.mdx".`,
    );
  }
  if (areas && areas.length === 0) {
    errors.push('Frontmatter field "areas" must contain at least one product area.');
  }
  if (
    !title ||
    !version ||
    !bump ||
    !pullRequest ||
    !issues ||
    !areas ||
    breaking === undefined ||
    !upgrade
  ) {
    return undefined;
  }
  return {
    areas,
    breaking,
    bump,
    issues,
    pullRequest,
    title,
    upgrade,
    version,
  };
}

function requiredString(
  value: unknown,
  key: string,
  errors: string[],
) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`Frontmatter field "${key}" must be a non-empty string.`);
    return undefined;
  }
  return value.trim();
}

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  key: string,
  errors: string[],
): T[number] | undefined {
  if (
    typeof value !== 'string' ||
    !allowed.includes(value as T[number])
  ) {
    errors.push(
      `Frontmatter field "${key}" must be one of: ${allowed.join(', ')}.`,
    );
    return undefined;
  }
  return value as T[number];
}

function positiveInteger(
  value: unknown,
  key: string,
  errors: string[],
) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    errors.push(`Frontmatter field "${key}" must be a positive integer.`);
    return undefined;
  }
  return value;
}

function integerList(
  value: unknown,
  key: string,
  errors: string[],
) {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== 'number' ||
        !Number.isSafeInteger(item) ||
        item <= 0,
    )
  ) {
    errors.push(
      `Frontmatter field "${key}" must be a list of positive integers (it may be empty).`,
    );
    return undefined;
  }
  if (new Set(value).size !== value.length) {
    errors.push(`Frontmatter field "${key}" may not contain duplicates.`);
  }
  return value as number[];
}

function enumList<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  key: string,
  errors: string[],
): T[number][] | undefined {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== 'string' ||
        !allowed.includes(item as T[number]),
    )
  ) {
    errors.push(
      `Frontmatter field "${key}" must use only: ${allowed.join(', ')}.`,
    );
    return undefined;
  }
  if (new Set(value).size !== value.length) {
    errors.push(`Frontmatter field "${key}" may not contain duplicates.`);
  }
  return value as T[number][];
}
