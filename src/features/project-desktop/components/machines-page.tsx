import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  Github,
  LoaderCircle,
  Network,
  RefreshCw
} from 'lucide-react';
import type { ProjectCliComputeInventory } from '@/shared/compute-inventory-cli-api';
import {
  Button,
  Chip,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Surface,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import { useComputeSources, type ComputeSourceStatus } from '../hooks/use-compute-sources';
import {
  computeSourceSections,
  countComputeSourceRows,
  filterComputeSourceSections,
  type MachineFilter
} from './machines-page-model';
import { GitHubCodespaceRow, TailscaleDeviceRow } from './compute-source-rows';
import type { SettingsMachineGroupsStatus } from './settings-machine-groups-view-model';

const filters: Array<{ id: MachineFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'available', label: 'Available' },
  { id: 'attention', label: 'Needs attention' }
];

function sourceRefreshLabel(status: ComputeSourceStatus) {
  switch (status) {
    case 'loading': return 'Loading';
    case 'refreshing': return 'Refreshing';
    case 'error': return 'Unavailable';
    default: return 'Current';
  }
}

function tailscaleSourceLabel(source: string | undefined) {
  switch (source) {
    case 'tailscale_oauth_api': return 'Deployment Tailscale API';
    case 'temporary_vps_local_status': return 'Temporary VPS inventory';
    case 'local_tailscale_command': return 'Local Tailscale inventory';
    default: return 'Tailscale not connected';
  }
}

function SourceHeader({
  count,
  description,
  icon: Icon,
  label,
  onRefresh,
  status
}: {
  count: number;
  description: string;
  icon: typeof Network;
  label: string;
  onRefresh(): void;
  status: ComputeSourceStatus;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 border-b border-neutral-800/70 pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-neutral-900 text-neutral-300">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Text as="h2" className="text-base font-semibold text-neutral-100">{label}</Text>
            <Chip size="sm">{count}</Chip>
            <Chip size="sm" className={cn(
              status === 'error' && 'text-amber-300',
              status === 'ready' && 'text-emerald-300'
            )}>{sourceRefreshLabel(status)}</Chip>
          </div>
          <Text className="mt-1 block text-xs text-neutral-500">{description}</Text>
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        isDisabled={status === 'loading' || status === 'refreshing'}
        onPress={onRefresh}
      >
        <RefreshCw className={cn('size-3.5', status === 'loading' || status === 'refreshing' ? 'animate-spin' : '')} />
        Refresh
      </Button>
    </div>
  );
}

function SourceMessage({ children, kind = 'empty' }: { children: React.ReactNode; kind?: 'empty' | 'error' }) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex min-h-28 items-center justify-center gap-2 px-5 text-center text-sm',
        kind === 'error' ? 'text-amber-200' : 'text-neutral-500'
      )}
    >
      {kind === 'error' ? <CircleAlert className="size-4 shrink-0" /> : null}
      <span>{children}</span>
    </div>
  );
}

export interface MachinesPageProps {
  computeInventory?: ProjectCliComputeInventory;
  inventoryStatus: SettingsMachineGroupsStatus;
  localSimulation: boolean;
  loadError: string;
  onRefresh(): Promise<unknown>;
}

export function MachinesPage(_props: MachinesPageProps) {
  const [filter, setFilter] = useState<MachineFilter>('all');
  const [query, setQuery] = useState('');
  const {
    classifyTailscaleDevice,
    github,
    refreshGitHub,
    refreshTailscale,
    tailscale
  } = useComputeSources();
  const sections = useMemo(() => computeSourceSections({
    codespaces: github.result?.codespaces,
    tailscaleDevices: tailscale.result?.devices
  }), [github.result?.codespaces, tailscale.result?.devices]);
  const visibleSections = useMemo(
    () => filterComputeSourceSections(sections, query, filter),
    [filter, query, sections]
  );
  const tailscaleSection = visibleSections[0]!;
  const githubSection = visibleSections[1]!;
  const tailscaleProviderNotice = tailscale.result?.provider.refreshState === 'partial'
    ? 'Tailscale returned a partial inventory. The available devices remain visible.'
    : tailscale.result?.provider.refreshState === 'unavailable'
      ? 'Tailscale is temporarily unavailable. Showing the last observed devices.'
      : '';
  const tailscaleDisplayStatus = tailscale.status === 'ready' &&
    tailscale.result?.provider.refreshState === 'unavailable'
    ? 'error'
    : tailscale.status;
  const checkedAt = [
    github.result?.checkedAt,
    ...((tailscale.result?.devices ?? []).map((device) => device.network.checkedAt))
  ].filter((value): value is string => Boolean(value)).sort().at(-1);

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-neutral-800/70 pb-4">
        <Text as="h1" className="block text-2xl font-semibold tracking-[-.02em] text-neutral-50">Compute</Text>
        <Text className="mt-1 block max-w-2xl text-sm text-neutral-500">
          Private-network devices and provider-owned development environments, grouped by their source of truth.
        </Text>
      </header>

      <div className="flex shrink-0 flex-col gap-3 border-b border-neutral-800/70 py-4 lg:flex-row lg:items-center lg:justify-between">
        <SearchField aria-label="Search compute" className="w-full lg:max-w-sm" onChange={setQuery} value={query}>
          <SearchFieldGroup className="h-10 rounded-full bg-neutral-900/80">
            <SearchFieldSearchIcon />
            <SearchFieldInput placeholder="Search devices and Codespaces" spellCheck={false} />
            <SearchFieldClearButton />
          </SearchFieldGroup>
        </SearchField>
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {filters.map(({ id, label }) => (
            <Button
              key={id}
              size="sm"
              variant={filter === id ? 'secondary' : 'ghost'}
              className="shrink-0 rounded-full"
              aria-pressed={filter === id}
              onPress={() => setFilter(id)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain py-5 pr-1">
        <Surface variant="transparent" className="rounded-2xl border border-neutral-800/80 p-4 sm:p-5">
          <SourceHeader
            count={sections[0]!.rows.length}
            description={tailscaleSourceLabel(tailscale.result?.provider.source)}
            icon={Network}
            label="Tailscale"
            status={tailscaleDisplayStatus}
            onRefresh={() => void refreshTailscale(true)}
          />
          {tailscale.error && tailscale.result ? <SourceMessage kind="error">{tailscale.error} Showing the last known devices.</SourceMessage> : null}
          {tailscaleProviderNotice ? <SourceMessage kind="error">{tailscaleProviderNotice}</SourceMessage> : null}
          {tailscale.error && !tailscale.result ? (
            <SourceMessage kind="error">{tailscale.error}</SourceMessage>
          ) : tailscale.status === 'loading' && !tailscale.result ? (
            <SourceMessage><LoaderCircle className="inline size-4 animate-spin" /> Loading Tailscale devices…</SourceMessage>
          ) : sections[0]!.rows.length === 0 ? (
            <SourceMessage>No Tailscale devices were reported.</SourceMessage>
          ) : tailscaleSection.rows.length === 0 ? (
            <SourceMessage>No Tailscale devices match this search or filter.</SourceMessage>
          ) : (
            <div className="divide-y divide-neutral-800/70">
              {tailscaleSection.rows.map((row) => row.kind === 'tailscale' ? (
                <TailscaleDeviceRow
                  key={row.id}
                  device={row.record}
                  onClassify={classifyTailscaleDevice}
                  onReload={() => refreshTailscale(false)}
                />
              ) : null)}
            </div>
          )}
        </Surface>

        <Surface variant="transparent" className="rounded-2xl border border-neutral-800/80 p-4 sm:p-5">
          <SourceHeader
            count={sections[1]!.rows.length}
            description="Codespaces owned and managed by GitHub"
            icon={Github}
            label="GitHub Codespaces"
            status={github.status}
            onRefresh={() => void refreshGitHub()}
          />
          {github.error && github.result ? <SourceMessage kind="error">{github.error} Showing the last known Codespaces.</SourceMessage> : null}
          {github.result?.provider.connectionState === 'not_connected' ? (
            <SourceMessage kind="error">Connect GitHub to load Codespaces.</SourceMessage>
          ) : github.result?.provider.connectionState === 'scope_insufficient' ? (
            <SourceMessage kind="error">Reconnect GitHub once to grant Codespaces access.</SourceMessage>
          ) : github.error && !github.result ? (
            <SourceMessage kind="error">{github.error}</SourceMessage>
          ) : github.status === 'loading' && !github.result ? (
            <SourceMessage><LoaderCircle className="inline size-4 animate-spin" /> Loading GitHub Codespaces…</SourceMessage>
          ) : sections[1]!.rows.length === 0 ? (
            <SourceMessage>No GitHub Codespaces were reported.</SourceMessage>
          ) : githubSection.rows.length === 0 ? (
            <SourceMessage>No GitHub Codespaces match this search or filter.</SourceMessage>
          ) : (
            <div className="divide-y divide-neutral-800/70">
              {githubSection.rows.map((row) => row.kind === 'github'
                ? <GitHubCodespaceRow key={row.id} codespace={row.record} />
                : null)}
            </div>
          )}
        </Surface>

        {countComputeSourceRows(sections) === 0 && tailscale.status === 'ready' && github.status === 'ready' ? (
          <div className="flex items-center justify-center gap-2 py-2 text-xs text-neutral-600">
            <CheckCircle2 className="size-4" /> Both sources are current.
          </div>
        ) : null}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-neutral-800/70 py-3 text-xs text-neutral-600">
        <span>{countComputeSourceRows(visibleSections)} visible · {sections[0]!.rows.length} Tailscale · {sections[1]!.rows.length} Codespaces</span>
        {checkedAt ? <span>Checked {new Date(checkedAt).toLocaleString()}</span> : null}
      </footer>
    </section>
  );
}
