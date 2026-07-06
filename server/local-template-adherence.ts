import { resolve } from 'node:path';

import type {
  TemplateAdherenceEntry,
  TemplateAdherenceEntryStatus,
  TemplateAdherenceFile,
  TemplateAdherenceReport,
  TemplateAdherenceRequest,
  TemplateAdherenceSummary
} from '../src/shared/project-space-api';
import { runProjectBinary } from './local-project-cli-client';

const entryStatuses: TemplateAdherenceEntryStatus[] = [
  'OK',
  'ADDED',
  'MISSING',
  'CHANGED',
  'WAIVED',
  'VIOLATION'
];

function isEntryStatus(value: unknown): value is TemplateAdherenceEntryStatus {
  return typeof value === 'string' && entryStatuses.includes(value as TemplateAdherenceEntryStatus);
}

function summarizeEntries(entries: TemplateAdherenceEntry[]): TemplateAdherenceSummary {
  const summary: TemplateAdherenceSummary = {
    added: 0,
    changed: 0,
    missing: 0,
    ok: 0,
    total: entries.length,
    violation: 0,
    waived: 0
  };

  for (const entry of entries) {
    if (entry.status === 'OK') summary.ok += 1;
    else if (entry.status === 'ADDED') summary.added += 1;
    else if (entry.status === 'MISSING') summary.missing += 1;
    else if (entry.status === 'CHANGED') summary.changed += 1;
    else if (entry.status === 'WAIVED') summary.waived += 1;
    else if (entry.status === 'VIOLATION') summary.violation += 1;
  }

  return summary;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseJsonEntries(rawEntries: unknown): TemplateAdherenceEntry[] {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const entries: TemplateAdherenceEntry[] = [];

  for (const rawEntry of rawEntries) {
    if (typeof rawEntry !== 'object' || rawEntry === null) {
      continue;
    }

    const record = rawEntry as Record<string, unknown>;

    if (typeof record.path !== 'string' || !isEntryStatus(record.status)) {
      continue;
    }

    entries.push({
      code: optionalString(record.code),
      kind: record.kind === 'dir' ? 'dir' : 'file',
      module: optionalString(record.module),
      note: optionalString(record.note),
      path: record.path,
      slot: optionalString(record.slot),
      status: record.status
    });
  }

  return entries;
}

function parseJsonFiles(rawFiles: unknown): TemplateAdherenceFile[] {
  if (!Array.isArray(rawFiles)) {
    return [];
  }

  const files: TemplateAdherenceFile[] = [];

  for (const rawFile of rawFiles) {
    if (typeof rawFile !== 'object' || rawFile === null) {
      continue;
    }

    const record = rawFile as Record<string, unknown>;

    if (typeof record.path !== 'string' || !isEntryStatus(record.status)) {
      continue;
    }

    const diagnostics = Array.isArray(record.diagnostics)
      ? record.diagnostics.flatMap((rawDiagnostic) => {
          if (typeof rawDiagnostic !== 'object' || rawDiagnostic === null) {
            return [];
          }

          const diagnostic = rawDiagnostic as Record<string, unknown>;

          if (typeof diagnostic.path !== 'string' || !isEntryStatus(diagnostic.status)) {
            return [];
          }

          return [
            {
              note: optionalString(diagnostic.note),
              path: diagnostic.path,
              status: diagnostic.status
            }
          ];
        })
      : undefined;

    files.push({
      code: optionalString(record.code),
      diagnostics: diagnostics && diagnostics.length > 0 ? diagnostics : undefined,
      module: optionalString(record.module),
      note: optionalString(record.note),
      path: record.path,
      status: record.status
    });
  }

  return files;
}

function parseJsonReport(
  stdout: string,
  cwd: string,
  durationMs: number
): TemplateAdherenceReport | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || !('structure' in parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const structure = parseJsonEntries(record.structure);
  const ok = record.ok === true;

  return {
    checkedAt: new Date().toISOString(),
    cwd,
    durationMs,
    files: parseJsonFiles(record.files),
    projectName: optionalString(record.projectName),
    status: ok ? 'ok' : 'violations',
    structure,
    summary: summarizeEntries(structure),
    templateLabel: optionalString(record.templateLabel)
  };
}

function parseTsvReport(
  stdout: string,
  cwd: string,
  durationMs: number
): TemplateAdherenceReport | undefined {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');

  if (lines.length === 0 || !lines[0].startsWith('status\t')) {
    return undefined;
  }

  const structure: TemplateAdherenceEntry[] = [];
  let ok: boolean | undefined;

  for (const line of lines.slice(1)) {
    const [status, kind, path, code, module] = line.split('\t');

    if (status === 'RESULT') {
      ok = code === 'ok';
      continue;
    }

    if (!isEntryStatus(status) || !path) {
      continue;
    }

    structure.push({
      code: optionalString(code),
      kind: kind === 'dir' ? 'dir' : 'file',
      module: module && module !== '-' ? module : undefined,
      path,
      status
    });
  }

  if (ok === undefined) {
    return undefined;
  }

  return {
    checkedAt: new Date().toISOString(),
    cwd,
    durationMs,
    files: [],
    status: ok ? 'ok' : 'violations',
    structure,
    summary: summarizeEntries(structure)
  };
}

function errorReport(cwd: string, durationMs: number, error: string): TemplateAdherenceReport {
  return {
    checkedAt: new Date().toISOString(),
    cwd,
    durationMs,
    // The project CLI prefixes fatal errors with "VIOLATION" on stderr.
    error: error.replace(/^VIOLATION\s+/, ''),
    files: [],
    status: 'error',
    structure: []
  };
}

export async function getTemplateAdherence(
  request: TemplateAdherenceRequest
): Promise<TemplateAdherenceReport> {
  const cwd = resolve(request.cwd);
  const jsonRun = await runProjectBinary(['validate', '--format', 'json'], cwd);
  const jsonReport = parseJsonReport(jsonRun.stdout, cwd, jsonRun.durationMs);

  if (jsonReport) {
    return jsonReport;
  }

  // Older project CLI builds only know pretty/tsv output.
  if (/unknown format/i.test(jsonRun.stderr)) {
    const tsvRun = await runProjectBinary(['validate', '--format', 'tsv'], cwd);
    const tsvReport = parseTsvReport(
      tsvRun.stdout,
      cwd,
      jsonRun.durationMs + tsvRun.durationMs
    );

    if (tsvReport) {
      return tsvReport;
    }

    return errorReport(
      cwd,
      jsonRun.durationMs + tsvRun.durationMs,
      tsvRun.stderr.trim() || 'Template validation produced no parseable output.'
    );
  }

  return errorReport(
    cwd,
    jsonRun.durationMs,
    jsonRun.stderr.trim() || 'Template validation produced no parseable output.'
  );
}
