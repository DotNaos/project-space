import { releaseBumps, type ReleaseBump } from '../releases/types';

export const prChangelogDirectory = 'changelog';
export const prChangelogSchema = 'project-space.pr-changelog/v1';

const fileNamePattern = /^[1-9]\d*\.md$/;
const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export interface PrChangelog {
  bump: ReleaseBump;
  body: string;
  fileName: string;
  pullRequest: number;
  summary: string;
}

export type PrChangelogParseResult =
  | { changelog: PrChangelog; ok: true }
  | { errors: string[]; ok: false };

export function isPrChangelogFileName(fileName: string) {
  return fileNamePattern.test(fileName);
}

export function parsePrChangelog(
  source: string,
  fileName: string,
): PrChangelogParseResult {
  const errors: string[] = [];
  if (!isPrChangelogFileName(fileName)) {
    errors.push(
      `Changelog filename "${fileName}" must be a positive pull request number with a .md extension.`,
    );
  }

  const match = frontmatterPattern.exec(source);
  if (!match) {
    errors.push(
      `${fileName} must start with YAML frontmatter delimited by --- lines.`,
    );
    return { errors, ok: false };
  }

  const metadata = parseMetadata(match[1], fileName, errors);
  const body = match[2].trim();
  if (!body) errors.push(`${fileName} must contain changelog text after frontmatter.`);

  const pullRequest = Number(fileName.slice(0, -3));
  if (!Number.isSafeInteger(pullRequest) || pullRequest <= 0) {
    errors.push(`${fileName} does not contain a safe positive pull request number.`);
  }
  const bump = metadata.bump;
  if (!bump || !releaseBumps.includes(bump as ReleaseBump)) {
    errors.push(
      `${fileName} must declare bump: patch, minor, or major; none is not allowed.`,
    );
  }

  if (errors.length > 0 || !bump) return { errors: unique(errors), ok: false };
  return {
    changelog: {
      body,
      bump: bump as ReleaseBump,
      fileName,
      pullRequest,
      summary: summaryFor(body),
    },
    ok: true,
  };
}

function parseMetadata(source: string, fileName: string, errors: string[]) {
  const result: Record<string, string> = {};
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(\S.*)?$/.exec(line);
    if (!match) {
      errors.push(`${fileName} frontmatter line ${index + 1} is invalid.`);
      continue;
    }
    const [, key, value = ''] = match;
    if (key !== 'bump') {
      errors.push(`${fileName} frontmatter may contain only the bump field.`);
      continue;
    }
    if (Object.hasOwn(result, key)) {
      errors.push(`${fileName} frontmatter field "bump" may appear only once.`);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function summaryFor(body: string) {
  const heading = body.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return body.split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'Changelog update';
}

function unique(values: string[]) {
  return [...new Set(values)];
}
