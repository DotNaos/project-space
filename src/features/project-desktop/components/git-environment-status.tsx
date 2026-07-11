import { ExternalLink, Radio, Server } from 'lucide-react';
import { Button, Chip, Text } from '@/app/dotnaos-ui';
import type { DeployedEnvironmentStatus } from '@/shared/project-space-api';
import { cn } from '@/lib/utils';

function statusLabel(environment: DeployedEnvironmentStatus, loaded: boolean) {
  if (environment.verification === 'healthy' && !loaded) return 'not in loaded history';
  return environment.verification;
}

export function EnvironmentMarker({ environment }: { environment: DeployedEnvironmentStatus }) {
  const isHealthy = environment.verification === 'healthy';
  return (
    <Chip size="sm" variant="secondary" className={cn(
      'h-6 shrink-0 gap-1.5 rounded-full border px-2 font-semibold shadow-sm',
      isHealthy
        ? 'border-emerald-300/70 bg-emerald-400/20 text-emerald-100 shadow-emerald-500/20'
        : environment.verification === 'inconsistent'
          ? 'border-amber-300/60 bg-amber-400/20 text-amber-100 shadow-amber-500/20'
          : 'border-rose-300/60 bg-rose-400/20 text-rose-100 shadow-rose-500/20'
    )}>
      {isHealthy ? <Radio className="size-3.5" /> : <Server className="size-3.5" />}
      {isHealthy ? <span className="text-[9px] uppercase tracking-[0.16em]">Live</span> : null}
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
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {environments.map((environment) => {
        const loaded = Boolean(environment.deployedSha && loadedHashes.has(environment.deployedSha));
        return (
          <Button
            key={environment.id}
            size="sm"
            variant="ghost"
            className={cn(
              'h-9 min-w-0 gap-2 rounded-lg border px-3 shadow-sm transition',
              environment.verification === 'healthy'
                ? 'border-emerald-400/50 bg-emerald-400/15 text-emerald-50 shadow-emerald-500/15 hover:bg-emerald-400/25'
                : environment.verification === 'inconsistent'
                  ? 'border-amber-400/40 bg-amber-400/10 text-amber-100'
                  : 'border-rose-400/30 bg-rose-400/10 text-rose-100',
              selectedHash === environment.deployedSha && 'ring-2 ring-current/35'
            )}
            onPress={() => loaded && environment.deployedSha && onSelect(environment.deployedSha)}
          >
            <Radio className={cn('size-4 shrink-0', environment.verification === 'healthy' && 'animate-pulse')} />
            <span className="text-[9px] font-bold uppercase tracking-[0.16em]">Live</span>
            <span className="truncate text-xs font-semibold">{environment.displayName}</span>
            <span className="rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-current/80">{environment.deployedSha?.slice(0, 8) ?? '—'}</span>
            <span className="hidden text-[10px] text-current/65 sm:inline">{environment.sourceRef ?? '—'} · {statusLabel(environment, loaded)}</span>
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
