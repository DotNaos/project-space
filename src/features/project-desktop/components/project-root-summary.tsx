import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { CircleDot, GitBranch, MessagesSquare, Monitor, Plus } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import { createProjectChatClient } from '@/api/project-chat-client';
import { loadGitHubRepositorySummary } from '@/api/github-repository-summary-client';
import {
  refreshProjectSpaceAuthToken
} from '@/api/project-space-client';
import { cn } from '@/lib/utils';
import type { ConnectorOverviewResult, ProjectSpaceRecord } from '@/shared/project-space-api';
import {
  acceptProjectRootSummaryResponse,
  loadProjectRootSummaryCounts,
  projectRootSummaryActions,
  projectRootSummaryCounts,
  projectRootSummaryHref,
  projectRootSummaryScopeKey,
  selectProjectRootSummaryTargets,
  type ProjectRootCount,
  type ProjectRootEvidence,
  type ProjectRootSummaryDataSource,
  type ProjectRootSummaryLoadResult,
  type ProjectRootSummaryRequestState,
  type ProjectRootSummaryTarget
} from './project-root-summary-model';

const projectChatClient = createProjectChatClient({
  getAuthToken: refreshProjectSpaceAuthToken
});

const defaultDataSource: ProjectRootSummaryDataSource = {
  getRepositorySummary: (fullName) => loadGitHubRepositorySummary(fullName),
  listProjectChatChannels: () => projectChatClient.listChannels(),
  listProjectChatMembers: (channelId) => projectChatClient.listMembers({ channelId })
};

export interface ProjectRootSummaryProps {
  className?: string;
  connector: ProjectRootEvidence<ConnectorOverviewResult>;
  dataSource?: ProjectRootSummaryDataSource;
  projects: ProjectSpaceRecord[];
  recentProjectIds: string[];
}

interface SummaryActionProps {
  count: ProjectRootCount;
  href: string;
  Icon: ComponentType<{ className?: string }>;
  label: string;
  projectLabel: string;
}

function CountValue({ count }: { count: ProjectRootCount }) {
  if (count.state === 'loading') {
    return (
      <span className="text-sm font-semibold text-neutral-500" aria-label="Loading">
        …
      </span>
    );
  }

  if (count.state === 'blocked') {
    return (
      <span
        className="text-sm font-semibold text-amber-300/80"
        aria-label={`Unavailable: ${count.message}`}
        title={count.message}
      >
        —
      </span>
    );
  }

  return <span className="text-sm font-semibold text-neutral-100">{count.count}</span>;
}

function SummaryAction({ count, href, Icon, label, projectLabel }: SummaryActionProps) {
  return (
    <a
      href={href}
      aria-label={`Open ${label.toLowerCase()} for ${projectLabel}`}
      className="group flex min-h-14 min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 transition hover:bg-neutral-900/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-400"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-neutral-400 transition group-hover:text-neutral-100">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <Text className="block truncate text-xs font-medium text-neutral-400 group-hover:text-neutral-200">
          {label}
        </Text>
      </span>
      <CountValue count={count} />
    </a>
  );
}

function ProjectSummaryRow({
  connector,
  loaded,
  routeHash,
  routeSearch,
  target
}: {
  connector: ProjectRootEvidence<ConnectorOverviewResult>;
  loaded?: ProjectRootSummaryLoadResult;
  routeHash: string;
  routeSearch: string;
  target: ProjectRootSummaryTarget;
}) {
  const actions = projectRootSummaryActions(target);
  const counts = projectRootSummaryCounts(target, connector, loaded);
  const href = (path: string) => projectRootSummaryHref(path, routeSearch, routeHash);

  return (
    <article className="py-5 first:pt-0 last:pb-0">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-4 px-1">
        <div className="min-w-0">
          <Text className="block truncate text-base font-semibold text-neutral-100">
            {target.label}
          </Text>
          <Text className="block truncate text-xs text-neutral-500">
            {target.repository?.owner ?? 'Local project'}
          </Text>
        </div>
        {actions.newIssue ? (
          <a
            href={href(actions.newIssue)}
            className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full bg-neutral-100 px-3.5 text-xs font-semibold text-neutral-950 transition hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-300"
          >
            <Plus className="size-4" />
            New issue
          </a>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
        <SummaryAction
          count={counts.issues}
          href={href(actions.issues)}
          Icon={CircleDot}
          label="Issues"
          projectLabel={target.label}
        />
        <SummaryAction
          count={counts.branches}
          href={href(actions.workspaces)}
          Icon={GitBranch}
          label="Branches"
          projectLabel={target.label}
        />
        <SummaryAction
          count={counts.threads}
          href={href(actions.chat)}
          Icon={MessagesSquare}
          label="Active threads"
          projectLabel={target.label}
        />
        <SummaryAction
          count={counts.machines}
          href={href(actions.machines)}
          Icon={Monitor}
          label="Machines"
          projectLabel={target.label}
        />
      </div>
    </article>
  );
}

export function ProjectRootSummary({
  className,
  connector,
  dataSource = defaultDataSource,
  projects,
  recentProjectIds
}: ProjectRootSummaryProps) {
  const targets = useMemo(
    () => selectProjectRootSummaryTargets(projects, recentProjectIds),
    [projects, recentProjectIds]
  );
  const generations = useRef<Record<string, number>>({});
  const [requests, setRequests] = useState<Record<string, ProjectRootSummaryRequestState>>({});
  const routeSearch = typeof window === 'undefined' ? '' : window.location.search;
  const routeHash = typeof window === 'undefined' ? '' : window.location.hash;

  useEffect(() => {
    let current = true;

    for (const target of targets) {
      const scopeKey = projectRootSummaryScopeKey(target);
      const generation = (generations.current[scopeKey] ?? 0) + 1;
      generations.current[scopeKey] = generation;
      setRequests((state) => ({
        ...state,
        [scopeKey]: { generation, scopeKey }
      }));

      void loadProjectRootSummaryCounts(target, dataSource).then((result) => {
        if (!current) return;
        setRequests((state) => {
          const request = state[scopeKey];
          if (!request) return state;
          const next = acceptProjectRootSummaryResponse(request, {
            generation,
            result,
            scopeKey
          });
          return next === request ? state : { ...state, [scopeKey]: next };
        });
      });
    }

    return () => {
      current = false;
    };
  }, [dataSource, targets]);

  return (
    <section className={cn('mx-auto w-full max-w-5xl', className)} aria-labelledby="recent-projects-heading">
      <div className="mb-4 px-1">
        <Text
          id="recent-projects-heading"
          className="block text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500"
        >
          Recent projects
        </Text>
        <Text className="mt-1 block text-sm text-neutral-400">
          Continue where you last worked.
        </Text>
      </div>

      {targets.length > 0 ? (
        <div className="divide-y divide-neutral-800/80">
          {targets.map((target) => {
            const scopeKey = projectRootSummaryScopeKey(target);
            return (
              <ProjectSummaryRow
                key={target.key}
                connector={connector}
                loaded={requests[scopeKey]?.result}
                routeHash={routeHash}
                routeSearch={routeSearch}
                target={target}
              />
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-neutral-800 px-4 py-8 text-center">
          <Text className="text-sm text-neutral-500">No projects discovered yet.</Text>
        </div>
      )}
    </section>
  );
}
