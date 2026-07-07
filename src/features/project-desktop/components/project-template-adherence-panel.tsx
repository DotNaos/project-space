import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  FileCheck2,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react';
import { Button, Chip, ScrollShadow, Surface, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  TemplateAdherenceDiagnostic,
  TemplateAdherenceEntry,
  TemplateAdherenceEntryStatus,
  TemplateAdherenceReport
} from '@/shared/project-space-api';
import { cn } from '@/lib/utils';
import {
  type AdherenceTreeNode,
  buildAdherenceTree,
  collectDirectoryPaths,
  collectIssueDirectoryPaths,
  entryStatusNote,
  filterTree,
  isIssueStatus,
  statusDotClass,
  statusLabels,
  statusSeverity,
  statusTextClass
} from './project-template-adherence-model';

interface ProjectTemplateAdherencePanelProps {
  refreshKey?: number;
  targetPath: string;
}

function StatusDot({ status }: { status: TemplateAdherenceEntryStatus }) {
  return <span className={cn('size-2 shrink-0 rounded-full', statusDotClass[status])} />;
}

function DiagnosticRow({ diagnostic }: { diagnostic: TemplateAdherenceDiagnostic }) {
  return (
    <div className="flex min-w-0 items-center gap-2 pl-6">
      <StatusDot status={diagnostic.status} />
      <Text className="shrink-0 font-mono text-xs text-neutral-400">{diagnostic.path}</Text>
      {diagnostic.note ? (
        <Text className="truncate text-xs text-neutral-500">{diagnostic.note}</Text>
      ) : null}
    </div>
  );
}

interface AdherenceTreeRowProps {
  depth: number;
  diagnosticsByPath: Map<string, TemplateAdherenceDiagnostic[]>;
  expandedPaths: Set<string>;
  node: AdherenceTreeNode;
  onTogglePath(path: string): void;
}

function AdherenceTreeRow({
  depth,
  diagnosticsByPath,
  expandedPaths,
  node,
  onTogglePath
}: AdherenceTreeRowProps) {
  const isDirectory = node.children.length > 0 || node.entry?.kind === 'dir';
  const isExpanded = expandedPaths.has(node.path);
  const status = node.entry?.status ?? node.worstStatus;
  const note = node.entry ? entryStatusNote(node.entry) : undefined;
  const diagnostics = diagnosticsByPath.get(node.path) ?? [];

  return (
    <div className="min-w-0">
      <button
        type="button"
        data-testid="template-adherence-tree-row"
        data-path={node.path}
        onClick={() => {
          if (isDirectory) {
            onTogglePath(node.path);
          }
        }}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition',
          isDirectory ? 'cursor-pointer hover:bg-neutral-900/70' : 'cursor-default'
        )}
        style={{ paddingLeft: `${depth * 1.1 + 0.5}rem` }}
      >
        {isDirectory ? (
          isExpanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-neutral-500" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-neutral-500" />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        {isDirectory ? (
          isExpanded ? (
            <FolderOpen className="size-4 shrink-0 text-neutral-500" />
          ) : (
            <Folder className="size-4 shrink-0 text-neutral-500" />
          )
        ) : (
          <FileText className="size-4 shrink-0 text-neutral-600" />
        )}
        <Text
          className={cn(
            'truncate font-mono text-xs',
            isIssueStatus(status) ? statusTextClass[status] : 'text-neutral-300'
          )}
        >
          {node.name}
          {isDirectory ? '/' : ''}
        </Text>
        <StatusDot status={status} />
        <Text className={cn('shrink-0 text-[11px]', statusTextClass[status])}>
          {statusLabels[status]}
        </Text>
        {node.entry?.module ? (
          <Text className="hidden shrink-0 text-[11px] text-neutral-600 sm:block">
            {node.entry.module}
          </Text>
        ) : null}
        {isDirectory && node.issueCount > 0 && !isExpanded ? (
          <Chip size="sm" variant="secondary" className="ml-auto shrink-0 text-amber-300">
            {node.issueCount} {node.issueCount === 1 ? 'issue' : 'issues'}
          </Chip>
        ) : null}
        {!isDirectory && note && isIssueStatus(status) ? (
          <Text className="ml-auto hidden shrink-0 truncate text-[11px] text-neutral-500 md:block md:max-w-56">
            {note}
          </Text>
        ) : null}
      </button>

      {!isDirectory && diagnostics.length > 0 ? (
        <div className="grid gap-1 pb-1" style={{ paddingLeft: `${depth * 1.1 + 1.5}rem` }}>
          {diagnostics.map((diagnostic) => (
            <DiagnosticRow key={`${node.path}:${diagnostic.path}`} diagnostic={diagnostic} />
          ))}
        </div>
      ) : null}

      {isDirectory && isExpanded
        ? node.children.map((child) => (
            <AdherenceTreeRow
              key={child.path}
              depth={depth + 1}
              diagnosticsByPath={diagnosticsByPath}
              expandedPaths={expandedPaths}
              node={child}
              onTogglePath={onTogglePath}
            />
          ))
        : null}
    </div>
  );
}

function ViolationListRow({
  diagnostics,
  entry
}: {
  diagnostics: TemplateAdherenceDiagnostic[];
  entry: TemplateAdherenceEntry;
}) {
  const note = entryStatusNote(entry);

  return (
    <Surface
      variant="tertiary"
      data-testid="template-adherence-violation-row"
      className="rounded-md border border-neutral-800 bg-black/20 px-3 py-2"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusDot status={entry.status} />
        <Text className={cn('shrink-0 text-xs font-semibold', statusTextClass[entry.status])}>
          {statusLabels[entry.status]}
        </Text>
        <Text className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-200">
          {entry.path}
        </Text>
        {entry.code ? (
          <Chip size="sm" variant="secondary" className="shrink-0">
            {entry.code}
          </Chip>
        ) : null}
        {entry.module ? (
          <Chip size="sm" variant="tertiary" className="shrink-0">
            {entry.module}
          </Chip>
        ) : null}
      </div>
      {note ? <Text className="mt-1 block pl-4 text-xs text-neutral-500">{note}</Text> : null}
      {diagnostics.length > 0 ? (
        <div className="mt-1 grid gap-1">
          {diagnostics.map((diagnostic) => (
            <DiagnosticRow key={`${entry.path}:${diagnostic.path}`} diagnostic={diagnostic} />
          ))}
        </div>
      ) : null}
    </Surface>
  );
}

export function ProjectTemplateAdherencePanel({
  refreshKey = 0,
  targetPath
}: ProjectTemplateAdherencePanelProps) {
  const [report, setReport] = useState<TemplateAdherenceReport>();
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [statusFilters, setStatusFilters] = useState<Set<TemplateAdherenceEntryStatus>>(new Set());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  async function runValidation() {
    if (!targetPath) {
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const nextReport = await projectSpaceClient.getTemplateAdherence({ cwd: targetPath });
      setReport(nextReport);

      const issueDirectories = new Set<string>();
      collectIssueDirectoryPaths(buildAdherenceTree(nextReport.structure), issueDirectories);
      setExpandedPaths(issueDirectories);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : 'Template validation request failed.'
      );
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    setReport(undefined);
    setStatusFilters(new Set());
    void runValidation();
  }, [refreshKey, targetPath]);

  const diagnosticsByPath = useMemo(() => {
    const byPath = new Map<string, TemplateAdherenceDiagnostic[]>();

    for (const file of report?.files ?? []) {
      const violations = (file.diagnostics ?? []).filter(
        (diagnostic) => diagnostic.status === 'VIOLATION'
      );

      if (violations.length > 0) {
        byPath.set(file.path, violations);
      }
    }

    return byPath;
  }, [report]);

  const tree = useMemo(() => buildAdherenceTree(report?.structure ?? []), [report]);

  const visibleTree = useMemo(() => {
    if (statusFilters.size === 0) {
      return tree;
    }

    return filterTree(tree, (node) => Boolean(node.entry && statusFilters.has(node.entry.status)));
  }, [tree, statusFilters]);

  const issues = useMemo(
    () =>
      (report?.structure ?? [])
        .filter((entry) => isIssueStatus(entry.status))
        .sort(
          (left, right) =>
            statusSeverity[right.status] - statusSeverity[left.status] ||
            left.path.localeCompare(right.path)
        ),
    [report]
  );

  const summary = report?.summary;
  const adherencePercent =
    summary && summary.total > 0
      ? Math.round(((summary.ok + summary.added + summary.waived) / summary.total) * 100)
      : undefined;

  function toggleStatusFilter(status: TemplateAdherenceEntryStatus) {
    const next = new Set(statusFilters);

    if (next.has(status)) {
      next.delete(status);
    } else {
      next.add(status);
    }

    if (next.size > 0) {
      const allDirectories = new Set<string>();
      collectDirectoryPaths(tree, allDirectories);
      setExpandedPaths(allDirectories);
    }

    setStatusFilters(next);
  }

  function togglePath(path: string) {
    setExpandedPaths((current) => {
      const next = new Set(current);

      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }

      return next;
    });
  }

  const summaryCounts: Array<{ count: number; status: TemplateAdherenceEntryStatus }> = summary
    ? [
        { count: summary.violation, status: 'VIOLATION' },
        { count: summary.missing, status: 'MISSING' },
        { count: summary.changed, status: 'CHANGED' },
        { count: summary.waived, status: 'WAIVED' },
        { count: summary.added, status: 'ADDED' },
        { count: summary.ok, status: 'OK' }
      ]
    : [];

  return (
    <Surface
      data-testid="template-adherence-panel"
      variant="secondary"
      className="grid gap-3 rounded-lg border border-neutral-800 bg-neutral-950/55 p-4"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileCheck2 className="size-4 shrink-0 text-neutral-400" />
          <div className="min-w-0">
            <Text className="block truncate text-sm font-semibold text-neutral-100">
              Template Adherence
            </Text>
            <Text className="block truncate text-xs text-neutral-500">
              {report?.templateLabel
                ? `Validated against ${report.templateLabel}`
                : 'Validates this workspace against its template snapshot.'}
            </Text>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {report?.status === 'ok' ? (
            <Chip size="sm" variant="primary" className="text-emerald-300">
              <ShieldCheck className="size-3.5" />
              adheres to template
            </Chip>
          ) : null}
          {report?.status === 'violations' ? (
            <Chip size="sm" variant="secondary" className="text-red-300">
              <ShieldAlert className="size-3.5" />
              {issues.length} {issues.length === 1 ? 'rule violated' : 'rules violated'}
            </Chip>
          ) : null}
          {report?.status === 'error' ? (
            <Chip size="sm" variant="secondary" className="text-amber-300">
              <AlertTriangle className="size-3.5" />
              validation unavailable
            </Chip>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            data-testid="template-adherence-rerun"
            isDisabled={!targetPath || isLoading}
            onPress={() => void runValidation()}
          >
            <RefreshCw className={cn('size-4', isLoading && 'animate-spin')} />
            {isLoading ? 'Validating' : 'Re-run'}
          </Button>
        </div>
      </div>

      {error ? (
        <Surface
          variant="tertiary"
          className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200"
        >
          {error}
        </Surface>
      ) : null}

      {report?.status === 'error' ? (
        <Surface
          variant="tertiary"
          className="rounded-md border border-amber-400/20 bg-amber-500/8 px-3 py-2"
        >
          <Text className="block text-sm text-amber-300">
            Template validation could not run for this target.
          </Text>
          <Text className="mt-1 block font-mono text-xs text-neutral-400">{report.error}</Text>
        </Surface>
      ) : null}

      {!report && !error ? (
        <div className="flex items-center gap-2 text-neutral-500">
          <CircleDashed className={cn('size-4', isLoading && 'animate-spin')} />
          <Text className="text-sm">
            {isLoading ? 'Running template validation…' : 'Select a target to validate.'}
          </Text>
        </div>
      ) : null}

      {summary ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {typeof adherencePercent === 'number' ? (
              <div className="flex min-w-40 flex-1 items-center gap-2">
                <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-neutral-800">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      report?.status === 'ok' ? 'bg-emerald-400' : 'bg-amber-400'
                    )}
                    style={{ width: `${adherencePercent}%` }}
                  />
                </div>
                <Text
                  data-testid="template-adherence-score"
                  className="shrink-0 text-xs font-semibold text-neutral-300"
                >
                  {adherencePercent}%
                </Text>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5">
              {summaryCounts.map(({ count, status }) => (
                <button
                  key={status}
                  type="button"
                  data-testid={`template-adherence-filter-${status.toLowerCase()}`}
                  onClick={() => toggleStatusFilter(status)}
                  disabled={count === 0}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition',
                    statusFilters.has(status)
                      ? 'border-neutral-500 bg-neutral-800 text-neutral-100'
                      : 'border-neutral-800 bg-neutral-950/60 text-neutral-400',
                    count === 0 ? 'opacity-40' : 'hover:border-neutral-600'
                  )}
                >
                  <StatusDot status={status} />
                  {statusLabels[status]}
                  <span className={statusTextClass[status]}>{count}</span>
                </button>
              ))}
            </div>
          </div>

          {issues.length > 0 ? (
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <ShieldAlert className="size-4 shrink-0 text-red-300" />
                <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
                  Rule violations
                </Text>
              </div>
              <ScrollShadow className="max-h-56" hideScrollBar>
                <div className="grid gap-1.5">
                  {issues.map((entry) => (
                    <ViolationListRow
                      key={entry.path}
                      diagnostics={diagnosticsByPath.get(entry.path) ?? []}
                      entry={entry}
                    />
                  ))}
                </div>
              </ScrollShadow>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 shrink-0 text-emerald-300" />
              <Text className="text-sm text-neutral-400">
                Every template rule passes for this target.
              </Text>
            </div>
          )}

          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Folder className="size-4 shrink-0 text-neutral-500" />
              <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
                Structure
              </Text>
              {statusFilters.size > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onPress={() => setStatusFilters(new Set())}
                >
                  Clear filters
                </Button>
              ) : null}
            </div>
            <ScrollShadow className="max-h-96" hideScrollBar>
              <div className="grid" data-testid="template-adherence-tree">
                {visibleTree.length > 0 ? (
                  visibleTree.map((node) => (
                    <AdherenceTreeRow
                      key={node.path}
                      depth={0}
                      diagnosticsByPath={diagnosticsByPath}
                      expandedPaths={expandedPaths}
                      node={node}
                      onTogglePath={togglePath}
                    />
                  ))
                ) : (
                  <Text className="px-2 py-1 text-sm text-neutral-500">
                    No entries match the current filters.
                  </Text>
                )}
              </div>
            </ScrollShadow>
          </div>
        </div>
      ) : null}
    </Surface>
  );
}
