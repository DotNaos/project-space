import { useEffect, useState } from 'react';
import { ExternalLink, GitBranch, Monitor, Network } from 'lucide-react';
import {
  Button,
  Chip,
  ListBox,
  ListBoxItem,
  Select,
  Text
} from '@/app/dotnaos-ui';
import {
  tailscaleDeviceClassifications,
  type TailscaleDeviceClassification,
  type TailscaleInventoryDevice
} from '@/shared/tailscale-inventory-api';
import type { GitHubCodespaceInventoryItem } from '@/shared/github-codespace-inventory-api';
import { cn } from '@/lib/utils';

const classificationLabels: Record<TailscaleDeviceClassification, string> = {
  console_endpoint: 'Console endpoint',
  deployment_destination: 'Deployment destination',
  environment: 'Environment',
  ignored: 'Ignored',
  unclassified: 'Unclassified'
};

function networkStateLabel(state: TailscaleInventoryDevice['network']['state']) {
  switch (state) {
    case 'online': return 'Online';
    case 'offline': return 'Offline';
    case 'stale': return 'Stale';
    default: return 'Unknown';
  }
}

function StatusChip({ label, state }: { label: string; state: 'available' | 'attention' | 'unknown' }) {
  return (
    <Chip size="sm" className={cn(
      'gap-1.5',
      state === 'available' && 'text-emerald-300',
      state === 'attention' && 'text-amber-300',
      state === 'unknown' && 'text-neutral-500'
    )}>
      <span className={cn(
        'size-1.5 rounded-full',
        state === 'available' && 'bg-emerald-400',
        state === 'attention' && 'bg-amber-400',
        state === 'unknown' && 'bg-neutral-600'
      )} />
      {label}
    </Chip>
  );
}

export function TailscaleDeviceRow({
  device,
  onClassify,
  onReload,
  classificationDisabled = false
}: {
  device: TailscaleInventoryDevice;
  onClassify(device: TailscaleInventoryDevice, value: TailscaleDeviceClassification): Promise<unknown>;
  onReload(): Promise<unknown>;
  classificationDisabled?: boolean;
}) {
  const [draft, setDraft] = useState<TailscaleDeviceClassification>(device.classification);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => setDraft(device.classification), [device.classification]);

  async function save() {
    if (draft === device.classification) return;
    setPending(true);
    setError('');
    try {
      await onClassify(device, draft);
    } catch {
      setError('This classification was not saved. Reload the device before trying again.');
    } finally {
      setPending(false);
    }
  }

  const status = device.network.state === 'online'
    ? 'available'
    : device.network.state === 'unknown' ? 'unknown' : 'attention';

  return (
    <div className="grid min-w-0 gap-4 py-5 lg:grid-cols-[minmax(0,1fr)_13rem_auto] lg:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-sky-500/10 text-sky-300">
          <Network className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Text className="font-medium text-neutral-100">{device.name?.trim() || 'Unnamed Tailscale device'}</Text>
            <StatusChip label={networkStateLabel(device.network.state)} state={status} />
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap gap-x-2 gap-y-1 font-mono text-xs text-neutral-400">
            {device.addresses.length > 0
              ? device.addresses.map((address) => <span key={address} className="break-all">{address}</span>)
              : <span className="font-sans text-amber-300/80">Direct Tailscale address unavailable from source</span>}
          </div>
          {[device.os, ...device.tags].filter(Boolean).length > 0 ? (
            <Text className="mt-1.5 block text-xs text-neutral-600">
              {[device.os, ...device.tags].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
          {classificationDisabled ? <Text className="mt-1.5 block text-xs text-amber-300/80">Classification is unavailable while the provider is unavailable.</Text> : null}
          {error ? (
            <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-200">
              <span>{error}</span>
              <Button size="sm" variant="ghost" onPress={() => void onReload()}>Reload</Button>
            </div>
          ) : null}
        </div>
      </div>
      <Select
        aria-label={`Classification for ${device.name?.trim() || 'Tailscale device'}`}
        isDisabled={classificationDisabled}
        className={pending || classificationDisabled ? 'pointer-events-none opacity-50' : undefined}
        value={draft}
        onChange={(value) => {
          if (classificationDisabled) return;
          if (value && tailscaleDeviceClassifications.includes(value as TailscaleDeviceClassification)) {
            setDraft(value as TailscaleDeviceClassification);
          }
        }}
      >
        <Select.Trigger className="h-10 rounded-lg border border-neutral-800 bg-neutral-900/70 px-3 text-left text-xs text-neutral-100 outline-none transition hover:border-neutral-700 focus-visible:ring-2 focus-visible:ring-sky-400/60">
          <span className="min-w-0 flex-1 truncate">{classificationLabels[draft]}</span>
          <Select.Indicator className="size-3.5 text-neutral-500" />
        </Select.Trigger>
        <Select.Popover className="w-60 rounded-lg border border-neutral-800 bg-neutral-950 p-1 shadow-2xl shadow-black/60">
          <ListBox selectedKeys={new Set([draft])} className="max-h-64 overflow-auto">
            {tailscaleDeviceClassifications.map((value) => (
              <ListBoxItem key={value} id={value} isDisabled={classificationDisabled} textValue={classificationLabels[value]} className="rounded-md px-2.5 py-2 text-xs text-neutral-200 hover:bg-neutral-900">
                {classificationLabels[value]}
              </ListBoxItem>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <Button size="sm" variant="secondary" isDisabled={classificationDisabled || pending || draft === device.classification} onPress={() => void save()}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}

function codespaceState(state: string) {
  const normalized = state.trim().toLowerCase();
  return normalized === 'available' || normalized === 'running'
    ? 'available'
    : normalized ? 'attention' : 'unknown';
}

export function GitHubCodespaceRow({ codespace }: { codespace: GitHubCodespaceInventoryItem }) {
  return (
    <div className="grid min-w-0 gap-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-violet-500/10 text-violet-300">
          <Monitor className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Text className="font-medium text-neutral-100">{codespace.displayName?.trim() || codespace.name}</Text>
            <StatusChip label={codespace.state || 'Unknown'} state={codespaceState(codespace.state)} />
          </div>
          <Text className="mt-1.5 block break-all text-xs text-neutral-400">{codespace.repositoryFullName}</Text>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-600">
            {codespace.ref ? <span className="inline-flex min-w-0 items-center gap-1"><GitBranch className="size-3 shrink-0" /><span className="break-all">{codespace.ref}</span></span> : null}
            <span>{new Date(codespace.createdAt).toLocaleDateString()}</span>
            <span className="font-mono">{codespace.name}</span>
          </div>
        </div>
      </div>
      {codespace.url ? (
        <a
          href={codespace.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-8 w-fit items-center justify-center gap-2 rounded-lg border border-transparent bg-neutral-800/80 px-2.5 text-xs font-medium text-neutral-100 transition hover:bg-neutral-700/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
        >
          Open <ExternalLink className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}
