import {
  type ReleaseBump,
  type ReleaseChange,
  type ReleaseChangeCategory,
  type ReleaseEntryParseResult,
  type ReleaseUpgrade,
} from './types';
import { parseReleaseFrontmatter } from './frontmatter';

const placeholderPattern =
  /\b(?:todo|tbd|lorem ipsum|coming soon|fill (?:this|me) in)\b|^(?:placeholder|short user-facing release title|concisely explain|describe one concrete)/i;
const bodyPattern =
  /^\s*<ReleaseSummary>\s*([\s\S]*?)\s*<\/ReleaseSummary>\s*## Changes\s*([\s\S]*?)(?:\s*## Breaking changes\s*([\s\S]*?))?\s*## Upgrade notes\s*<UpgradeNotes type="(none|required)">\s*([\s\S]*?)\s*<\/UpgradeNotes>\s*<PreviewOnly>\s*## What to test\s*([\s\S]*?)\s*<\/PreviewOnly>\s*$/;

export function parseReleaseEntryMdx(
  source: string,
  fileName: string,
): ReleaseEntryParseResult {
  const errors: string[] = [];
  const normalized = source.replaceAll('\r\n', '\n');
  const document = splitFrontmatter(normalized, errors);
  if (!document) return { ok: false, errors };

  const metadata = parseReleaseFrontmatter(
    document.frontmatter,
    fileName,
    errors,
  );
  validateSafeMdx(document.body, errors);
  const body = parseBody(document.body, errors);

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
  if (metadata.breaking && metadata.bump === 'minor') {
    errors.push('Minor releases may not declare breaking changes.');
  }
  if (!metadata.breaking && metadata.bump === 'major') {
    errors.push('Major releases must declare breaking: true.');
  }
  if (metadata.breaking && metadata.upgrade !== 'required') {
    errors.push(
      'A breaking release must declare upgrade: "required".',
    );
  }
  if (
    metadata.upgrade === 'required' &&
    body.upgradeNotes.includes('No manual action is required.')
  ) {
    errors.push(
      'upgrade: "required" may not claim that no manual action is required.',
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

function normalizeParagraph(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function unique(values: string[]) {
  return [...new Set(values)];
}
