import {
  releaseAreas,
  releaseBumps,
  releaseChangeCategories,
  type ReleaseArea,
  type ReleaseBump,
  type ReleaseChange,
  type ReleaseChangeCategory,
  type ReleaseEntry,
  type ReleaseEntryParseResult,
  type ReleaseUpgrade,
} from './types';
import { parseStableSemver } from './semver';

const frontmatterKeySet = new Set([
  'title',
  'version',
  'bump',
  'pullRequest',
  'issues',
  'areas',
  'breaking',
  'upgrade',
]);
const placeholderPattern =
  /\b(?:todo|tbd|placeholder|lorem ipsum|coming soon|fill (?:this|me) in)\b/i;
const bodyPattern =
  /^\s*<ReleaseSummary>\s*([\s\S]*?)\s*<\/ReleaseSummary>\s*## Changes\s*([\s\S]*?)(?:\s*## Breaking changes\s*([\s\S]*?))?\s*## Upgrade notes\s*<UpgradeNotes type="(none|required)">\s*([\s\S]*?)\s*<\/UpgradeNotes>\s*<PreviewOnly>\s*## What to test\s*([\s\S]*?)\s*<\/PreviewOnly>\s*$/;

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

export function parseReleaseEntryMdx(
  source: string,
  fileName: string,
): ReleaseEntryParseResult {
  const errors: string[] = [];
  const normalized = source.replaceAll('\r\n', '\n');
  const document = splitFrontmatter(normalized, errors);
  if (!document) return { ok: false, errors };

  const frontmatter = parseFrontmatter(document.frontmatter, errors);
  validateSafeMdx(document.body, errors);
  const body = parseBody(document.body, errors);
  const metadata = validateFrontmatter(frontmatter, fileName, errors);

  if (!body || !metadata) {
    return { ok: false, errors: unique(errors) };
  }

  validateContradictions(metadata, body, errors);
  validatePlaceholders(metadata, body, errors);
  if (errors.length > 0) {
    return { ok: false, errors: unique(errors) };
  }

  return {
    ok: true,
    entry: {
      ...metadata,
      ...body,
      fileName,
    },
  };
}

function splitFrontmatter(source: string, errors: string[]) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
  if (!match) {
    errors.push(
      'Release entry must begin with YAML frontmatter enclosed by standalone --- lines.',
    );
    return undefined;
  }
  return { frontmatter: match[1], body: match[2] };
}

function parseFrontmatter(
  source: string,
  errors: string[],
): ParsedFrontmatter {
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
    if (!frontmatterKeySet.has(key)) {
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

  return result;
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
) {
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
    areas: areas as ReleaseArea[],
    breaking,
    bump: bump as ReleaseBump,
    issues,
    pullRequest,
    title,
    upgrade: upgrade as ReleaseUpgrade,
    version,
  };
}

function validateSafeMdx(body: string, errors: string[]) {
  if (/^\s*(?:import|export)\s/m.test(body)) {
    errors.push('Release MDX may not import or export code.');
  }
  if (/[{}]/.test(body)) {
    errors.push('Release MDX expressions are not allowed.');
  }
  if (/<!--|-->|<\?|\?>/.test(body)) {
    errors.push('Release MDX comments and processing instructions are not allowed.');
  }
  if (/!\[[^\]]*]\(/.test(body)) {
    errors.push('Release MDX images are not allowed.');
  }

  const allowedTags = new Set([
    'ReleaseSummary',
    'UpgradeNotes',
    'PreviewOnly',
  ]);
  for (const match of body.matchAll(/<\/?([A-Za-z][\w.-]*)([^>]*)>/g)) {
    const [, name, attributes] = match;
    const closing = match[0].startsWith('</');
    if (!allowedTags.has(name)) {
      errors.push(`Release MDX element <${name}> is not allowed.`);
      continue;
    }
    if (
      name === 'UpgradeNotes' &&
      !closing &&
      !/^ type="(?:none|required)"$/.test(attributes)
    ) {
      errors.push(
        'UpgradeNotes accepts only type="none" or type="required".',
      );
    } else if (
      (name !== 'UpgradeNotes' || closing) &&
      attributes.trim()
    ) {
      errors.push(`Release MDX element <${name}> may not have attributes.`);
    }
  }

  for (const match of body.matchAll(/]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (
      !href.startsWith('https://') &&
      !href.startsWith('/') &&
      !href.startsWith('#')
    ) {
      errors.push(
        `Release MDX link "${href}" must use HTTPS, a Docs path, or an anchor.`,
      );
    }
  }
}

function parseBody(body: string, errors: string[]) {
  const match = bodyPattern.exec(body);
  if (!match) {
    errors.push(
      'Release body must follow the required order: ReleaseSummary, Changes, optional Breaking changes, Upgrade notes, then PreviewOnly What to test.',
    );
    return undefined;
  }

  const summary = normalizeParagraph(match[1]);
  const changes = parseChanges(match[2], errors);
  const breakingChanges = match[3]
    ? parseBulletList(match[3], 'Breaking changes', errors)
    : [];
  const upgradeType = match[4] as ReleaseUpgrade;
  const upgradeNotes = parseNotes(match[5], 'Upgrade notes', errors);
  const previewTests = parseBulletList(
    match[6],
    'What to test',
    errors,
  );

  if (summary.length < 20) {
    errors.push('ReleaseSummary must contain a concise user-facing summary.');
  }
  if (changes.length === 0) {
    errors.push(
      'Changes must contain at least one non-empty supported category.',
    );
  }
  if (upgradeNotes.length === 0) {
    errors.push('Upgrade notes must not be empty.');
  }
  if (previewTests.length === 0) {
    errors.push('What to test must contain at least one concrete Preview check.');
  }

  return {
    breakingChanges,
    changes,
    previewTests,
    summary,
    upgradeNotes,
    upgradeType,
  };
}

function parseChanges(source: string, errors: string[]) {
  const headingPattern =
    /^### (Added|Changed|Fixed|Deprecated|Removed|Security)\s*$/gm;
  const headings = [...source.matchAll(headingPattern)];
  const prefix = source.slice(0, headings[0]?.index ?? source.length);
  if (prefix.trim()) {
    errors.push('Changes may contain only supported ### category sections.');
  }

  const changes: ReleaseChange[] = [];
  const seen = new Set<string>();
  headings.forEach((heading, index) => {
    const category = heading[1] as ReleaseChangeCategory;
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? source.length;
    const items = parseBulletList(
      source.slice(start, end),
      `${category} changes`,
      errors,
    );
    if (seen.has(category)) {
      errors.push(`Changes category "${category}" may appear only once.`);
      return;
    }
    seen.add(category);
    if (items.length > 0) changes.push({ category, items });
  });

  return changes;
}

function parseBulletList(
  source: string,
  label: string,
  errors: string[],
) {
  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const items: string[] = [];
  for (const line of lines) {
    const match = /^-\s+(.+)$/.exec(line);
    if (!match) {
      errors.push(`${label} must use non-empty Markdown bullet items.`);
      continue;
    }
    const item = match[1].trim();
    if (item) items.push(item);
  }
  return items;
}

function parseNotes(
  source: string,
  label: string,
  errors: string[],
) {
  const paragraphs = source
    .trim()
    .split(/\n\s*\n/)
    .map(normalizeParagraph)
    .filter(Boolean);
  if (paragraphs.some((paragraph) => /^#{1,6}\s/.test(paragraph))) {
    errors.push(`${label} may not contain nested headings.`);
  }
  return paragraphs;
}

function validateContradictions(
  metadata: {
    breaking: boolean;
    bump: ReleaseBump;
    upgrade: ReleaseUpgrade;
  },
  body: {
    breakingChanges: string[];
    upgradeNotes: string[];
    upgradeType: ReleaseUpgrade;
  },
  errors: string[],
) {
  if (metadata.upgrade !== body.upgradeType) {
    errors.push(
      `Frontmatter upgrade "${metadata.upgrade}" contradicts UpgradeNotes type "${body.upgradeType}".`,
    );
  }
  if (
    metadata.upgrade === 'none' &&
    (body.upgradeNotes.length !== 1 ||
      body.upgradeNotes[0] !== 'No manual action is required.')
  ) {
    errors.push(
      'upgrade: "none" must contain exactly "No manual action is required."',
    );
  }
  if (metadata.breaking && body.breakingChanges.length === 0) {
    errors.push(
      'breaking: true requires a non-empty Breaking changes section.',
    );
  }
  if (!metadata.breaking && body.breakingChanges.length > 0) {
    errors.push(
      'A Breaking changes section requires breaking: true.',
    );
  }
  if (metadata.breaking && metadata.bump === 'patch') {
    errors.push('Patch releases may not declare breaking changes.');
  }
  if (metadata.breaking && metadata.upgrade !== 'required') {
    errors.push(
      'A breaking release must declare upgrade: "required".',
    );
  }
}

function validatePlaceholders(
  metadata: { title: string },
  body: {
    breakingChanges: string[];
    changes: ReleaseChange[];
    previewTests: string[];
    summary: string;
    upgradeNotes: string[];
  },
  errors: string[],
) {
  const authoredText = [
    metadata.title,
    body.summary,
    ...body.breakingChanges,
    ...body.changes.flatMap((change) => change.items),
    ...body.previewTests,
    ...body.upgradeNotes,
  ];
  if (authoredText.some((value) => placeholderPattern.test(value))) {
    errors.push(
      'Release entry contains placeholder text; describe the actual release instead.',
    );
  }
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
  if (typeof value !== 'string' || !allowed.includes(value)) {
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
        typeof item !== 'string' || !allowed.includes(item),
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

function normalizeParagraph(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function unique(values: string[]) {
  return [...new Set(values)];
}
