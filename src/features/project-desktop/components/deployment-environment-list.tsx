import { ExternalLink, GitBranch, Radio } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import type { DeployedEnvironmentStatus, GitHubWorkflowRunSummary } from '@/shared/project-space-api';
import { environmentStatusLabel, environmentTone, sortEnvironments } from './deployment-status-model';
import { StatusChip, StatusIcon } from './deployment-status-ui';
import { PublicDeploymentLink } from './public-deployment-link';

export function DeploymentEnvironmentList({ environments, loadedCommitShas, runs = [] }: {
  environments: DeployedEnvironmentStatus[];
  loadedCommitShas?: ReadonlySet<string>;
  runs?: GitHubWorkflowRunSummary[];
}) {
  if (environments.length === 0) return <EmptyLine>No deployed environments were reported for this repository.</EmptyLine>;
  return <div className="divide-y divide-neutral-800/70 border-y border-neutral-800/70">
    {sortEnvironments(environments).map((environment) => {
      const tone = environmentTone(environment);
      const producingRun = environment.deployedSha
        ? runs.find((run) => run.headSha === environment.deployedSha && run.kind === 'deployment')
        : undefined;
      return <div key={environment.id} className="grid min-w-0 gap-2 px-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <StatusIcon tone={tone} />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Text className="truncate text-sm font-semibold text-neutral-100">{environment.displayName}</Text>
              <span className="font-mono text-[10px] text-neutral-600">{environment.id}</span>
              {environment.verification === 'healthy' ? <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-300"><Radio className="size-3" />Live</span> : null}
              <StatusChip tone={tone}>{environmentStatusLabel(environment, loadedCommitShas)}</StatusChip>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
              {environment.sourceRef ? <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{environment.sourceRef}</span> : <span>source not reported</span>}
              {producingRun ? <span>produced by run #{producingRun.runNumber ?? producingRun.id}</span> : null}
              {environment.verifiedAt ? <span>verified {new Date(environment.verifiedAt).toLocaleString()}</span> : <span>verification time unavailable</span>}
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-3 pl-7 sm:justify-end sm:pl-0">
          <span className="max-w-full truncate font-mono text-xs text-neutral-300" title={environment.deployedSha}>{environment.deployedSha ? `${environment.deployedSha.slice(0, 7)} · ${environment.deployedSha}` : 'running revision unavailable'}</span>
          {environment.liveUrl
            ? <PublicDeploymentLink environmentName={environment.displayName} href={environment.liveUrl} />
            : <Text className="text-xs text-neutral-600">
                {environment.liveUrlState === 'withheld' ? 'Private URL withheld' : 'No public URL'}
              </Text>}
          {environment.githubUrl ? <ExternalAnchor href={environment.githubUrl}>Commit</ExternalAnchor> : null}
        </div>
      </div>;
    })}
  </div>;
}

function ExternalAnchor({ children, href }: { children: React.ReactNode; href: string }) {
  return <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-100">{children}<ExternalLink className="size-3" /></a>;
}

export function EmptyLine({ children }: { children: React.ReactNode }) {
  return <div className="border-y border-neutral-800/70 px-1 py-4"><Text className="text-sm text-neutral-500">{children}</Text></div>;
}
