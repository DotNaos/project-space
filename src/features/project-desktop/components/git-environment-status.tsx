import { ExternalLink, Server } from 'lucide-react';
import { Button, Chip, Text } from '@/app/dotnaos-ui';
import type { DeployedEnvironmentStatus } from '@/shared/project-space-api';
import { cn } from '@/lib/utils';

function statusLabel(environment: DeployedEnvironmentStatus, loaded: boolean) {
  if (environment.verification === 'healthy' && !loaded) return 'not in loaded history';
  return environment.verification;
}

export function EnvironmentMarker({ environment }: { environment: DeployedEnvironmentStatus }) {
  return (
    <Chip size="sm" variant="secondary" className={cn(
      'shrink-0 gap-1',
      environment.verification === 'healthy'
        ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200'
        : environment.verification === 'inconsistent'
          ? 'border-amber-400/25 bg-amber-400/10 text-amber-200'
          : 'border-rose-400/25 bg-rose-400/10 text-rose-200'
    )}>
      <Server className="size-3" />
      {environment.displayName}
    </Chip>
  );
}

export function GitEnvironmentSummary({
  environments,
  loadedHashes,
  driftByEnvironment,
  onSelect,
  selectedHash,
  status
}: {
  environments: DeployedEnvironmentStatus[];
  driftByEnvironment?: ReadonlyMap<string, number | undefined>;
  loadedHashes: ReadonlySet<string>;
  onSelect(hash: string): void;
  selectedHash?: string;
  status: 'available' | 'unauthorized' | 'unavailable' | 'loading';
}) {
  if (status !== 'available') {
    return <Text className="text-xs text-neutral-500">Environments {status}</Text>;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      {environments.map((environment) => {
        const loaded = Boolean(environment.deployedSha && loadedHashes.has(environment.deployedSha));
        return (
          <Button
            key={environment.id}
            size="sm"
            variant="ghost"
            className={cn('h-7 min-w-0 gap-1.5 px-1.5', selectedHash === environment.deployedSha && 'bg-neutral-800')}
            onPress={() => loaded && environment.deployedSha && onSelect(environment.deployedSha)}
          >
            <span className={cn('size-1.5 rounded-full', environment.verification === 'healthy' ? 'bg-emerald-400' : environment.verification === 'inconsistent' ? 'bg-amber-400' : 'bg-rose-400')} />
            <span className="truncate text-xs">{environment.displayName}</span>
            <span className="font-mono text-[10px] text-neutral-500">{environment.deployedSha?.slice(0, 8) ?? '—'}</span>
            <span className="hidden text-[10px] text-neutral-500 sm:inline">{environment.sourceRef ?? '—'} · {statusLabel(environment, loaded)}</span>
            {driftByEnvironment?.get(environment.id) ? <span className="hidden text-[10px] text-amber-300 sm:inline">{driftByEnvironment.get(environment.id)} behind</span> : null}
          </Button>
        );
      })}
    </div>
  );
}

export function SelectedCommitEnvironments({ environments }: { environments: DeployedEnvironmentStatus[] }) {
  if (environments.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800/70 px-4 py-2">
      {environments.map((environment) => (
        <div key={environment.id} className="flex min-w-0 items-center gap-2 text-xs">
          <EnvironmentMarker environment={environment} />
          <span className="font-mono text-neutral-500" title={environment.deployedSha}>{environment.deployedSha}</span>
          {environment.sourceRef ? <span className="text-neutral-500">from {environment.sourceRef}</span> : null}
          {environment.verifiedAt ? <span className="text-neutral-500">verified {new Date(environment.verifiedAt).toLocaleString()}</span> : null}
          {environment.liveUrl ? <a href={environment.liveUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-neutral-300 hover:text-white">Live <ExternalLink className="size-3" /></a> : null}
          {environment.githubUrl ? <a href={environment.githubUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-neutral-300 hover:text-white">Commit <ExternalLink className="size-3" /></a> : null}
        </div>
      ))}
    </div>
  );
}
