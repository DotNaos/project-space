import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, GitBranch, ListChecks, RefreshCw, Route } from 'lucide-react';

import { Button, Surface, Text } from '@/app/dotnaos-ui';
import type { GitHubCatalogRepository, ProjectSpaceRecord } from '@/shared/project-space-api';
import type { RoadmapIssueNode } from '@/shared/roadmap-api';
import { RoadmapGoalEditor } from './roadmap-goal-editor';
import { RoadmapInspector } from './roadmap-inspector';
import { nextRoadmapPlanEntry } from './roadmap-model';
import { RoadmapStory } from './roadmap-story';
import { useRoadmap } from './use-roadmap';
import { useRoadmapRepository } from './use-roadmap-repository';

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
  const [selectedIssueId, setSelectedIssueId] = useState<number>();
  const selectedIssue = roadmap.result?.issues.find((issue) => issue.issue.id === selectedIssueId);
  useEffect(() => setSelectedIssueId(undefined), [roadmapRepository?.id]);
  const next = useMemo(() => {
    const result = roadmap.result;
    if (!result) return undefined;
    return nextRoadmapPlanEntry(result.plan, result.issues);
  }, [roadmap.result]);

  const openIssue = (issue: RoadmapIssueNode) => {
    if (issue.issue.fullName.toLowerCase() === roadmapRepository?.fullName.toLowerCase()) {
      onOpenIssue(issue.issue.number);
    } else if (issue.issue.url) {
      window.open(issue.issue.url, '_blank', 'noopener,noreferrer');
    }
  };

  if (repositoryDiscovery.isLoading) {
    return <div className="grid gap-3 py-8">{Array.from({ length: 5 }, (_, index) => <div key={index} className="mx-auto h-24 w-full max-w-2xl animate-pulse rounded-xl bg-neutral-900/70" />)}</div>;
  }
  if (!roadmapRepository) {
    return <RoadmapMessage
      title="No GitHub repository"
      message={repositoryDiscovery.error || 'Link a GitHub repository before planning its roadmap.'}
    />;
  }
  if (roadmap.isLoading && !roadmap.result) {
    return <div className="grid gap-3 py-8">{Array.from({ length: 5 }, (_, index) => <div key={index} className="mx-auto h-24 w-full max-w-2xl animate-pulse rounded-xl bg-neutral-900/70" />)}</div>;
  }
  if (!roadmap.result) {
    return <RoadmapMessage title="Roadmap unavailable" message={roadmap.error || 'Could not load the roadmap.'} onRetry={roadmap.refresh} />;
  }
  const result = roadmap.result;
  if (result.status !== 'connected') {
    return <RoadmapMessage title="Roadmap unavailable" message={result.message ?? 'Connect GitHub to load this roadmap.'} onRetry={roadmap.refresh} />;
  }

  return (
    <Surface variant="transparent" className="min-h-full min-w-0 pb-12">
      <header className="mb-5 flex min-w-0 flex-col gap-4 border-b border-neutral-800/80 pb-5">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-sm:w-full">
            <span className="flex items-center gap-2 text-neutral-500">
              <Route className="size-4" />
              <Text className="text-[11px] font-semibold uppercase tracking-[0.16em]">Roadmap story</Text>
            </span>
            <Text as="h2" className="mt-2 text-xl font-semibold text-neutral-50">
              What should we work on next?
            </Text>
            {next?.issue ? (
              <button className="mt-2 flex min-w-0 max-w-full items-start gap-2 text-left text-sm text-emerald-300 hover:text-emerald-200" onClick={() => openIssue(next.issue as RoadmapIssueNode)} type="button">
                <span className="size-2 shrink-0 rounded-full bg-emerald-400" />
                <span className="min-w-0 line-clamp-2">{next.item.plannedState === 'active' ? 'Continue' : 'Ready next'}: #{next.issue.issue.number} {next.issue.title}</span>
                <ArrowRight className="mt-0.5 size-3.5 shrink-0" />
              </button>
            ) : (
              <Text className="mt-2 block text-sm text-neutral-500">No unblocked planned work is ready yet.</Text>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onPress={onSelectIssues} size="sm" variant="secondary"><ListChecks className="size-3.5" /> Plan in Issues</Button>
            <Button aria-label="Refresh roadmap" isIconOnly onPress={roadmap.refresh} size="sm" variant="ghost"><RefreshCw className="size-3.5" /></Button>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-500">
          <span>{result.plan.items.length} planned</span>
          <span>{result.dependencies.length} GitHub dependencies</span>
          <span>{result.plan.revision ? `Plan revision ${result.plan.revision}` : 'No shared plan saved yet'}</span>
          <span>{result.canEdit ? 'Editable with your GitHub access' : 'Read only'}</span>
        </div>
      </header>

      {roadmap.error ? <div role="alert" className="mb-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{roadmap.error}</div> : null}
      {result.dependencySync === 'stale' ? (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> GitHub dependencies could not be refreshed. The last visible snapshot is marked stale and editing is paused.
        </div>
      ) : null}
      {result.issues.some((issue) => issue.availability === 'cyclic') ? (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          <GitBranch className="mt-0.5 size-4 shrink-0" /> GitHub currently contains a dependency cycle. Break it before relying on the planned order.
        </div>
      ) : null}
      <div aria-live="polite" className="sr-only">{roadmap.announcement}</div>

      <RoadmapGoalEditor roadmap={roadmap} />
      {result.plan.items.length === 0 ? (
        <div className="flex min-h-80 flex-col items-center justify-center gap-3 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-neutral-900"><Route className="size-5 text-neutral-500" /></span>
          <Text className="text-base font-semibold text-neutral-200">Start the story in Issues</Text>
          <Text className="max-w-sm text-sm text-neutral-500">Add work from the backlog, then arrange its honest implementation order here.</Text>
          <Button onPress={onSelectIssues} variant="secondary"><ListChecks className="size-4" /> Open Issues</Button>
        </div>
      ) : (
        <div className="mt-5 grid min-w-0 gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
          <RoadmapStory
            onOpenIssue={openIssue}
            onSelect={(issue) => setSelectedIssueId(issue.issue.id)}
            result={result}
            selectedIssueId={selectedIssueId}
          />
          <RoadmapInspector issue={selectedIssue} onClose={() => setSelectedIssueId(undefined)} roadmap={roadmap} />
        </div>
      )}
    </Surface>
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
