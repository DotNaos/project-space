import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  GitBranch,
  ListChecks,
  Pencil,
  Plus,
  RefreshCw,
  Route
} from 'lucide-react';

import { Button, Surface, Text } from '@/app/dotnaos-ui';
import type { GitHubCatalogRepository, ProjectSpaceRecord } from '@/shared/project-space-api';
import type { RoadmapIssueNode } from '@/shared/roadmap-api';
import {
  RoadmapGoalEditor,
  type RoadmapEditorMode
} from './roadmap-goal-editor';
import { RoadmapGraph } from './roadmap-graph';
import { RoadmapInspector } from './roadmap-inspector';
import { nextRoadmapPlanEntry } from './roadmap-model';
import { useRoadmap } from './use-roadmap';
import { useRoadmapIssues } from './use-roadmap-issues';
import { useRoadmapRepository } from './use-roadmap-repository';
import { useRoadmapSelection } from './use-roadmap-selection';

export function RoadmapPanel({
  onOpenIssue,
  onSelectIssues,
  project,
  repository
}: {
  onOpenIssue(issueNumber: number): void;
  onSelectIssues(): void;
  project: ProjectSpaceRecord;
  repository?: GitHubCatalogRepository;
}) {
  const repositoryDiscovery = useRoadmapRepository(project, repository);
  const roadmapRepository = repositoryDiscovery.repository;
  const roadmap = useRoadmap(roadmapRepository?.fullName);
  const issueCatalog = useRoadmapIssues(roadmapRepository?.fullName);
  const {
    clear: clearSelection,
    select: selectIssue,
    selectedIssueId
  } = useRoadmapSelection(roadmap.result?.repository.id);
  const [editorMode, setEditorMode] = useState<RoadmapEditorMode>(null);
  const compact = useCompactRoadmap();
  const selectedIssue = roadmap.result?.issues.find(
    (issue) => issue.issue.id === selectedIssueId
  );
  useEffect(() => {
    if (selectedIssueId && roadmap.result && !selectedIssue) clearSelection();
  }, [clearSelection, roadmap.result, selectedIssue, selectedIssueId]);
  const next = useMemo(() => {
    const result = roadmap.result;
    return result ? nextRoadmapPlanEntry(result.plan, result.issues) : undefined;
  }, [roadmap.result]);

  const openIssue = (issue: RoadmapIssueNode) => {
    if (issue.issue.fullName.toLowerCase() === roadmapRepository?.fullName.toLowerCase()) {
      onOpenIssue(issue.issue.number);
    } else if (issue.issue.url) {
      window.open(issue.issue.url, '_blank', 'noopener,noreferrer');
    }
  };

  if (repositoryDiscovery.isLoading) return <RoadmapSkeleton />;
  if (!roadmapRepository) {
    return <RoadmapMessage
      title="No GitHub repository"
      message={repositoryDiscovery.error || 'Link a GitHub repository before planning its roadmap.'}
    />;
  }
  if (roadmap.isLoading && !roadmap.result) return <RoadmapSkeleton />;
  if (!roadmap.result) {
    return <RoadmapMessage title="Roadmap unavailable" message={roadmap.error || 'Could not load the roadmap.'} onRetry={roadmap.refresh} />;
  }
  const result = roadmap.result;
  const canEdit = result.canEdit && result.dependencySync === 'current';
  if (result.status !== 'connected') {
    return <RoadmapMessage title="Roadmap unavailable" message={result.message ?? 'Connect GitHub to load this roadmap.'} onRetry={roadmap.refresh} />;
  }

  return (
    <Surface variant="transparent" className="min-h-full min-w-0 overflow-x-hidden pb-12">
      <header className="mb-5 flex min-w-0 flex-col gap-4 border-b border-neutral-800/80 pb-5">
        <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <span className="flex items-center gap-2 text-neutral-500">
              <Route className="size-4" />
              <Text className="text-[11px] font-semibold uppercase tracking-[0.16em]">Roadmap</Text>
            </span>
            <Text as="h2" className="mt-2 text-2xl font-semibold tracking-tight text-neutral-50 max-sm:text-xl">
              What should we work on next?
            </Text>
            <Text className="mt-1 block max-w-2xl text-sm text-neutral-500">
              {next?.issue
                ? `#${next.issue.issue.number} is ready${next.issue.title ? ` · ${next.issue.title}` : ''}`
                : 'No unblocked planned work is ready yet.'}
            </Text>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            {next?.issue ? (
              <Button
                className="col-span-2 !bg-emerald-600 !text-white hover:!bg-emerald-500 sm:col-span-1"
                onPress={() => openIssue(next.issue as RoadmapIssueNode)}
                variant="primary"
              ><ArrowRight className="size-4" /> Open #{next.issue.issue.number}</Button>
            ) : null}
            <Button isDisabled={!canEdit || roadmap.isSaving} onPress={() => setEditorMode('work')} variant="secondary">
              <Plus className="size-4" /> Add work
            </Button>
            <Button isDisabled={!canEdit || roadmap.isSaving} onPress={() => setEditorMode('goals')} variant="secondary">
              <Pencil className="size-4" /> Edit plan
            </Button>
            {!compact ? (
              <Button aria-label="Refresh roadmap" isIconOnly onPress={roadmap.refresh} variant="ghost">
                <RefreshCw className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-500 max-md:hidden">
          <span>{result.plan.items.length} in manual plan order</span>
          <span>{result.dependencies.length} dependency arrow{result.dependencies.length === 1 ? '' : 's'}</span>
          <span>{result.plan.goals.length} goal{result.plan.goals.length === 1 ? '' : 's'}</span>
          <span>{result.canEdit ? 'Editable with your GitHub access' : 'Read only'}</span>
        </div>
      </header>

      {roadmap.error ? <div role="alert" className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{roadmap.error}</div> : null}
      {result.dependencySync === 'stale' ? (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> GitHub dependencies could not be refreshed. Relationship and order edits are paused until refresh succeeds.
        </div>
      ) : null}
      {result.issues.some((issue) => issue.availability === 'cyclic') ? (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          <GitBranch className="mt-0.5 size-4 shrink-0" /> GitHub currently contains a dependency cycle. Break it before relying on this graph.
        </div>
      ) : null}
      <div aria-live="polite" className="sr-only">{roadmap.announcement}</div>

      <RoadmapGoalEditor
        issueError={issueCatalog.error}
        issues={issueCatalog.issues}
        isLoadingIssues={issueCatalog.isLoading}
        mode={editorMode}
        onModeChange={setEditorMode}
        roadmap={roadmap}
      />

      {result.plan.items.length === 0 ? (
        <RoadmapEmpty
          hasGoals={result.plan.goals.length > 0}
          isEditable={canEdit && !roadmap.isSaving}
          onAddWork={() => setEditorMode(result.plan.goals.length > 0 ? 'goals' : 'work')}
          onOpenIssues={onSelectIssues}
        />
      ) : (
        <div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_19rem]">
          <RoadmapGraph
            compact={compact}
            onSelect={(issue) => selectIssue(issue.issue.id)}
            result={result}
            selectedIssueId={selectedIssueId}
          />
          <RoadmapInspector
            issue={selectedIssue}
            issueError={issueCatalog.error}
            issues={issueCatalog.issues}
            isLoadingIssues={issueCatalog.isLoading}
            onClose={() => clearSelection()}
            roadmap={roadmap}
          />
        </div>
      )}
    </Surface>
  );
}

function RoadmapEmpty({
  hasGoals,
  isEditable,
  onAddWork,
  onOpenIssues
}: {
  hasGoals: boolean;
  isEditable: boolean;
  onAddWork(): void;
  onOpenIssues(): void;
}) {
  return (
    <div className="flex min-h-96 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-neutral-800 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-neutral-900"><Route className="size-5 text-neutral-500" /></span>
      <Text className="text-base font-semibold text-neutral-200">
        {hasGoals ? 'No work planned yet' : 'Build the first roadmap branch'}
      </Text>
      <Text className="max-w-sm text-sm text-neutral-500">
        {hasGoals
          ? 'Add the first existing GitHub issue to a goal.'
          : 'Choose existing issues, then connect only their real prerequisite relationships.'}
      </Text>
      <div className="flex flex-wrap justify-center gap-2">
        <Button isDisabled={!isEditable} onPress={onAddWork} variant="primary"><Plus className="size-4" /> {hasGoals ? 'Add first issue' : 'Add work'}</Button>
        <Button onPress={onOpenIssues} variant="secondary"><ListChecks className="size-4" /> Open full backlog</Button>
      </div>
    </div>
  );
}

function RoadmapSkeleton() {
  return (
    <div className="grid gap-4 py-4" aria-label="Loading roadmap">
      <div className="h-24 animate-pulse rounded-xl bg-neutral-900/70" />
      <div className="h-[34rem] animate-pulse rounded-2xl bg-neutral-900/45" />
    </div>
  );
}

function RoadmapMessage({ message, onRetry, title }: { message: string; onRetry?(): void; title: string }) {
  return (
    <div className="flex min-h-80 flex-col items-center justify-center gap-3 p-6 text-center">
      <Text className="text-base font-semibold text-neutral-200">{title}</Text>
      <Text className="max-w-sm text-sm text-neutral-500">{message}</Text>
      {onRetry ? <Button onPress={onRetry} size="sm" variant="secondary">Retry</Button> : null}
    </div>
  );
}

function useCompactRoadmap() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}
