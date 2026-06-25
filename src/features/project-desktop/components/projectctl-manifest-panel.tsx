import { useEffect, useMemo, useState } from 'react';
import { Button, Chip, ScrollShadow, Surface, Text } from '@/app/dotnaos-ui';
import {
  ClipboardList,
  FileCheck2,
  FileWarning,
  GitCompareArrows,
  RefreshCw,
  Route
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  ProjectctlOverviewResult,
  ProjectctlPlanOperation,
  ProjectctlPlanResult
} from '@/shared/project-space-api';

interface ProjectctlManifestPanelProps {
  targetPath: string;
}

function statusLabel(overview?: ProjectctlOverviewResult) {
  if (!overview?.available) {
    return 'tool missing';
  }
  if (!overview.inspect?.hasProject && !overview.inspect?.hasLock) {
    return 'unmanaged';
  }
  if (overview.status?.conflictCount) {
    return 'conflicts';
  }
  if (overview.status?.changes) {
    return 'drift';
  }
  return 'in sync';
}

function statusVariant(label: string) {
  if (label === 'in sync') {
    return 'primary';
  }
  if (label === 'tool missing' || label === 'conflicts') {
    return 'secondary';
  }
  return 'secondary';
}

function visibleOperations(plan?: ProjectctlPlanResult) {
  return (plan?.operations ?? []).filter((operation) => operation.kind !== 'noop');
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.find((value) => value && value.trim().length > 0);
}

function OperationRow({ operation }: { operation: ProjectctlPlanOperation }) {
  return (
    <Surface
      variant="tertiary"
      className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 rounded-md border border-slate-800 bg-black/20 px-3 py-2"
    >
      <Chip
        size="sm"
        variant="secondary"
        className={operation.kind === 'conflict' ? 'border-amber-400/30 text-amber-300' : ''}
      >
        {operation.kind}
      </Chip>
      <div className="min-w-0">
        <Text className="block truncate font-mono text-xs text-slate-200">{operation.path}</Text>
        {operation.reason || operation.owner ? (
          <Text className="block truncate text-xs text-slate-500">
            {[operation.owner, operation.reason].filter(Boolean).join(' / ')}
          </Text>
        ) : null}
      </div>
    </Surface>
  );
}

export function ProjectctlManifestPanel({ targetPath }: ProjectctlManifestPanelProps) {
  const [overview, setOverview] = useState<ProjectctlOverviewResult>();
  const [preview, setPreview] = useState<ProjectctlPlanResult>();
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  async function refresh() {
    if (!targetPath) {
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      const nextOverview = await projectSpaceClient.loadProjectctlOverview(targetPath);
      setOverview(nextOverview);
      setPreview(nextOverview.preview);
      if (nextOverview.error) {
        setError(nextOverview.error);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not load projectctl status.');
    } finally {
      setIsLoading(false);
    }
  }

  async function loadPreview() {
    if (!targetPath) {
      return;
    }
    setIsPreviewLoading(true);
    setError('');
    try {
      setPreview(await projectSpaceClient.loadProjectctlPreview(targetPath));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not preview projectctl changes.');
    } finally {
      setIsPreviewLoading(false);
    }
  }

  useEffect(() => {
    setPreview(undefined);
    void refresh();
  }, [targetPath]);

  const label = statusLabel(overview);
  const inspect = overview?.inspect;
  const manifestProject = inspect?.project?.project ?? inspect?.lock?.project;
  const presetName = firstNonEmpty(inspect?.project?.preset?.name, inspect?.lock?.preset?.name) ?? 'custom';
  const templateVersion = firstNonEmpty(inspect?.lock?.template?.version, inspect?.templateVersion) ?? 'unknown';
  const environments = inspect?.project?.environments ?? [];
  const capabilities = inspect?.capabilities ?? inspect?.lock?.capabilities ?? [];
  const features = inspect?.features ?? inspect?.lock?.features ?? {};
  const missingMarkers = (inspect?.markers ?? []).filter((marker) => !marker.present);
  const operations = visibleOperations(preview ?? overview?.status);
  const enabledFeatureCount = useMemo(
    () => Object.values(features).filter((feature) => feature.status === 'enabled').length,
    [features]
  );

  return (
    <Surface
      variant="secondary"
      className="grid shrink-0 gap-3 rounded-lg border border-slate-800 bg-slate-950/55 p-3 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)]"
    >
      <div className="grid min-w-0 gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <ClipboardList className="size-4 shrink-0 text-slate-400" />
            <Text className="truncate text-sm font-semibold text-slate-100">Project Manifest</Text>
          </div>
          <div className="flex items-center gap-2">
            <Chip size="sm" variant={statusVariant(label)}>
              {label}
            </Chip>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={!targetPath || isLoading}
              onPress={() => void refresh()}
            >
              <RefreshCw className={`size-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          <Surface variant="tertiary" className="rounded-lg border border-slate-800 bg-black/20 p-3">
            <Text className="block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Kind
            </Text>
            <Text className="mt-1 block truncate text-sm text-slate-100">
              {manifestProject?.kind ?? 'unknown'}
            </Text>
          </Surface>
          <Surface variant="tertiary" className="rounded-lg border border-slate-800 bg-black/20 p-3">
            <Text className="block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Preset
            </Text>
            <Text className="mt-1 block truncate text-sm text-slate-100">{presetName}</Text>
          </Surface>
          <Surface variant="tertiary" className="rounded-lg border border-slate-800 bg-black/20 p-3">
            <Text className="block text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Template
            </Text>
            <Text className="mt-1 block truncate font-mono text-sm text-slate-100">
              {templateVersion}
            </Text>
          </Surface>
        </div>

        <div className="flex flex-wrap gap-2">
          {environments.length > 0 ? (
            environments.map((environment) => (
              <Chip key={environment.name} size="sm" variant={environment.default ? 'primary' : 'secondary'}>
                {environment.name}
              </Chip>
            ))
          ) : (
            <Chip size="sm" variant="tertiary">
              no environments
            </Chip>
          )}
          <Chip size="sm" variant="secondary">
            {enabledFeatureCount} enabled features
          </Chip>
          <Chip size="sm" variant={inspect?.hasGoals ? 'primary' : 'secondary'}>
            GOALS.md
          </Chip>
        </div>

        {error ? (
          <Surface
            variant="tertiary"
            className="rounded-lg border border-amber-400/20 bg-amber-500/8 px-4 py-3 text-sm text-amber-300"
          >
            {error}
          </Surface>
        ) : null}
      </div>

      <div className="grid min-w-0 gap-3">
        <div className="flex items-center gap-2">
          <GitCompareArrows className="size-4 shrink-0 text-slate-400" />
          <Text className="truncate text-sm font-semibold text-slate-100">Standard Drift</Text>
          <div className="ml-auto flex items-center gap-2">
            <Chip size="sm" variant={preview?.changes ? 'secondary' : 'primary'}>
              {preview ? preview.summary : overview?.status?.summary ?? 'not checked'}
            </Chip>
            <Button
              size="sm"
              variant="outline"
              isDisabled={!targetPath || !overview?.available || !overview.inspect?.hasProject || isPreviewLoading}
              onPress={() => void loadPreview()}
            >
              <Route className={`size-4 ${isPreviewLoading ? 'animate-spin' : ''}`} />
              Preview
            </Button>
          </div>
        </div>

        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Surface variant="tertiary" className="min-h-32 rounded-lg border border-slate-800 bg-black/20 p-3">
            <div className="mb-2 flex items-center gap-2">
              <FileCheck2 className="size-4 text-slate-400" />
              <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Capabilities
              </Text>
            </div>
            <ScrollShadow className="max-h-28" hideScrollBar>
              <div className="flex flex-wrap gap-2">
                {capabilities.length > 0 ? (
                  capabilities.map((capability) => (
                    <Chip key={capability} size="sm" variant="secondary">
                      {capability}
                    </Chip>
                  ))
                ) : (
                  <Text className="text-sm text-slate-500">No capabilities recorded yet.</Text>
                )}
              </div>
            </ScrollShadow>
          </Surface>

          <Surface variant="tertiary" className="min-h-32 rounded-lg border border-slate-800 bg-black/20 p-3">
            <div className="mb-2 flex items-center gap-2">
              <FileWarning className="size-4 text-slate-400" />
              <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Missing
              </Text>
            </div>
            <ScrollShadow className="max-h-28" hideScrollBar>
              <div className="grid gap-2">
                {missingMarkers.length > 0 ? (
                  missingMarkers.slice(0, 6).map((marker) => (
                    <Text key={marker.path} className="truncate font-mono text-xs text-slate-400">
                      {marker.path}
                    </Text>
                  ))
                ) : (
                  <Text className="text-sm text-slate-500">All tracked markers are present.</Text>
                )}
              </div>
            </ScrollShadow>
          </Surface>
        </div>

        {operations.length > 0 ? (
          <ScrollShadow className="max-h-44" hideScrollBar>
            <div className="grid gap-2">
              {operations.map((operation) => (
                <OperationRow key={`${operation.kind}:${operation.path}`} operation={operation} />
              ))}
            </div>
          </ScrollShadow>
        ) : (
          <Surface
            variant="tertiary"
            className="rounded-lg border border-slate-800 bg-black/20 px-3 py-2 text-sm text-slate-500"
          >
            No planned file changes.
          </Surface>
        )}
      </div>
    </Surface>
  );
}
