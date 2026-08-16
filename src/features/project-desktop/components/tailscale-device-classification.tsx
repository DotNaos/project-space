import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@heroui/react';
import { Network, RefreshCw } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Chip, ListBox, ListBoxItem, Select, Text } from '@/app/dotnaos-ui';
import {
  tailscaleDeviceClassifications,
  type TailscaleDeviceClassification as TailscaleClassification,
  type TailscaleInventoryDevice,
  type TailscaleInventoryResult,
  type TailscaleInventorySourceKind
} from '@/shared/tailscale-inventory-api';

const classificationLabels: Record<TailscaleClassification, string> = {
  console_endpoint: 'Console endpoint',
  deployment_destination: 'Deployment destination',
  environment: 'Environment',
  ignored: 'Ignored',
  unclassified: 'Unclassified'
};

export function tailnetNetworkStateLabel(state: TailscaleInventoryDevice['network']['state']) {
  switch (state) {
    case 'online': return 'Online';
    case 'offline': return 'Offline';
    case 'stale': return 'Stale';
    default: return 'Unknown';
  }
}

export function tailnetDeviceLabel(device: Pick<TailscaleInventoryDevice, 'id' | 'name'>) {
  return device.name?.trim() || 'Unnamed device';
}

function providerRefreshLabel(value: TailscaleInventoryResult['provider']['refreshState']) {
  switch (value) {
    case 'available': return 'Provider available';
    case 'partial': return 'Provider partial';
    case 'unavailable': return 'Provider unavailable';
    default: return 'Provider not checked';
  }
}

function providerSourceLabel(source: TailscaleInventorySourceKind | undefined) {
  switch (source) {
    case 'tailscale_oauth_api': return 'Tailscale API';
    case 'temporary_vps_local_status': return 'Temporary VPS local Tailscale';
    case 'local_tailscale_command': return 'Local Tailscale command';
    default: return 'No Tailscale connection';
  }
}

export function TailscaleDeviceClassification() {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<TailscaleInventoryResult>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, TailscaleClassification>>({});
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setLoadError('');
    try {
      const next = await projectSpaceClient.getTailscaleInventory(refresh);
      setInventory(next);
      setDrafts(Object.fromEntries(next.devices.map((device) => [device.id, device.classification])));
      setRowErrors({});
    } catch {
      setLoadError('Tailnet inventory could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load(true);
    }
  }, [load, open]);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  const save = useCallback(async (device: TailscaleInventoryDevice) => {
    const classification = drafts[device.id] ?? device.classification;
    if (classification === device.classification) return;
    setPendingIds((current) => new Set(current).add(device.id));
    setRowErrors((current) => ({ ...current, [device.id]: '' }));
    try {
      const saved = await projectSpaceClient.setTailscaleDeviceClassification(device.id, {
        classification, expectedRevision: device.revision
      });
      setInventory((current) => current && {
        ...current,
        devices: current.devices.map((entry) => entry.id === device.id
          ? { ...entry, classification: saved.classification, revision: saved.revision }
          : entry)
      });
    } catch {
      setRowErrors((current) => ({
        ...current,
        [device.id]: 'The device may have changed or the classification was not saved. Reload before trying again.'
      }));
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(device.id);
        return next;
      });
    }
  }, [drafts]);

  const source = inventory?.provider.source;
  const sourceLabel = providerSourceLabel(source);
  const connectionState = inventory?.provider.connectionState;

  return (
    <>
      <Button size="sm" variant="secondary" onPress={() => setOpen(true)}>
        <Network className="size-4" />Tailnet devices
      </Button>
      <Modal isOpen={open} onOpenChange={(nextOpen) => {
        if (nextOpen) setOpen(true);
        else close();
      }}>
        <Modal.Backdrop variant="blur" className="z-[110] bg-black/75">
          <Modal.Container placement="auto" scroll="inside" size="lg" className="p-0 sm:p-5">
            <Modal.Dialog className="flex h-[min(44rem,calc(100dvh-0.75rem))] max-h-[calc(100dvh-env(safe-area-inset-top)-0.75rem)] w-full max-w-none flex-col overflow-hidden rounded-t-[1.75rem] rounded-b-none border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl sm:h-auto sm:max-h-[min(44rem,92dvh)] sm:max-w-4xl sm:rounded-2xl">
              <Modal.Header className="flex-row items-start gap-3 border-b border-neutral-800 px-5 py-4 sm:px-6">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-sky-500/10 text-sky-300"><Network className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <Modal.Heading className="text-base font-semibold">Tailnet devices</Modal.Heading>
                  <Text className="mt-1 block text-xs text-neutral-500">Classify devices before they can enter a Project Space surface. Environment creates a hostless Compute environment; it never invents a Host.</Text>
                </span>
                <Modal.CloseTrigger aria-label="Close Tailnet devices" className="text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100" />
              </Modal.Header>
              <Modal.Body className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip size="sm" className="text-neutral-300">{sourceLabel}</Chip>
                    <Chip size="sm" className="text-neutral-400">{inventory ? providerRefreshLabel(inventory.provider.refreshState) : 'Provider not checked'}</Chip>
                  </div>
                  <Button size="sm" variant="ghost" isDisabled={loading} onPress={() => void load(true)}>
                    <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />Refresh devices
                  </Button>
                </div>
                {source === 'tailscale_oauth_api' && connectionState === 'connected' ? (
                  <div className="mb-4 border-y border-sky-500/20 py-3">
                    <Text className="block text-sm font-medium text-neutral-100">Connected to Tailscale API</Text>
                    <Text className="mt-1 block text-xs text-neutral-500">This deployment’s infrastructure credential is configured outside the application and applies to its authorized users.</Text>
                  </div>
                ) : null}
                {connectionState === 'configured' ? (
                  <div className="mb-4 border-y border-sky-500/20 py-3">
                    <Text className="block text-sm font-medium text-neutral-100">Tailscale is configured for this deployment</Text>
                    <Text className="mt-1 block text-xs text-neutral-500">Refresh devices to verify the deployment credential and load current Tailnet evidence.</Text>
                  </div>
                ) : null}
                {connectionState === 'legacy' ? (
                  <div className="mb-4 border-y border-amber-500/20 py-3">
                    <Text className="block text-sm font-medium text-neutral-100">Temporary VPS local Tailscale</Text>
                    <Text className="mt-1 block text-xs text-neutral-500">This temporary server-local source remains active until deployment-owned OAuth inventory is configured and proven.</Text>
                  </div>
                ) : null}
                {connectionState === 'not_configured' ? (
                  <div className="mb-4 border-y border-neutral-800 py-3">
                    <Text className="block text-sm font-medium text-neutral-100">Tailscale is not configured</Text>
                    <Text className="mt-1 block text-xs text-neutral-500">Configure the deployment’s Tailscale OAuth client through its secret manager.</Text>
                  </div>
                ) : null}
                {connectionState === 'configuration_error' || connectionState === 'authentication_error' || connectionState === 'scope_insufficient' || connectionState === 'unavailable' ? (
                  <div role="alert" className="mb-4 border-y border-amber-500/25 py-3 text-xs text-amber-100">
                    {connectionState === 'scope_insufficient'
                      ? 'The deployment credential does not have the required devices:core:read scope.'
                      : connectionState === 'unavailable'
                        ? 'Tailscale is temporarily unavailable for this deployment.'
                        : 'The deployment’s Tailscale credential could not be used. Update it in the deployment secret manager.'}
                  </div>
                ) : null}
                {loadError ? <div role="alert" className="rounded-lg border border-amber-500/25 bg-amber-500/[.07] px-3 py-2 text-xs text-amber-100">{loadError}</div> : null}
                {loading && !inventory ? <Text className="block py-10 text-center text-sm text-neutral-500">Loading Tailnet devices…</Text> : null}
                {!loading && inventory?.devices.length === 0 ? <Text className="block py-10 text-center text-sm text-neutral-500">No Tailnet devices were found.</Text> : null}
                <div className="divide-y divide-neutral-800/70">
                  {inventory?.devices.map((device) => {
                    const draft = drafts[device.id] ?? device.classification;
                    const pending = pendingIds.has(device.id);
                    const error = rowErrors[device.id];
                    return (
                      <div key={device.id} className="grid gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_12rem_auto] lg:items-center">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <Text className="font-medium text-neutral-100">{tailnetDeviceLabel(device)}</Text>
                            <Chip size="sm" className="text-neutral-400">{tailnetNetworkStateLabel(device.network.state)}</Chip>
                          </div>
                          <Text className="mt-1 block font-mono text-[11px] text-neutral-500">ID · …{device.id.slice(-10)}</Text>
                          <Text className="mt-1 block text-xs text-neutral-500">{device.addresses.join(' · ') || 'No exact Tailscale IP reported'}{device.os ? ` · ${device.os}` : ''}</Text>
                          {error ? <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-200"><span>{error}</span><Button size="sm" variant="ghost" isDisabled={loading || pending} onPress={() => void load(false)}>Reload</Button></div> : null}
                        </div>
                        <Select aria-label={`Classification for ${tailnetDeviceLabel(device)}`} className={pending ? 'pointer-events-none opacity-50' : undefined} value={draft} onChange={(value) => {
                          if (!pending && value && tailscaleDeviceClassifications.includes(value as TailscaleClassification)) {
                            setDrafts((current) => ({ ...current, [device.id]: value as TailscaleClassification }));
                          }
                        }}>
                          <Select.Trigger className="h-9 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 text-left text-xs text-neutral-100 outline-none transition hover:border-neutral-700 focus-visible:ring-2 focus-visible:ring-sky-400/60">
                            <span className="min-w-0 flex-1 truncate">{classificationLabels[draft]}</span><Select.Indicator className="size-3.5 text-neutral-500" />
                          </Select.Trigger>
                          <Select.Popover className="w-60 rounded-lg border border-neutral-800 bg-neutral-950 p-1 shadow-2xl shadow-black/60">
                            <ListBox selectedKeys={new Set([draft])} className="max-h-64 overflow-auto">
                              {tailscaleDeviceClassifications.map((value) => <ListBoxItem key={value} id={value} textValue={classificationLabels[value]} className="rounded-md px-2.5 py-2 text-xs text-neutral-200 hover:bg-neutral-900">{classificationLabels[value]}</ListBoxItem>)}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                        <Button size="sm" variant="secondary" isDisabled={pending || draft === device.classification} onPress={() => void save(device)}>{pending ? 'Saving…' : 'Save'}</Button>
                      </div>
                    );
                  })}
                </div>
              </Modal.Body>
              <Modal.Footer className="flex-row items-center justify-between border-t border-neutral-800 px-5 py-4 sm:px-6">
                <Text className="text-xs text-neutral-500">Unclassified, deployment, console, and ignored devices are not Compute environments.</Text>
                <Button size="sm" variant="ghost" onPress={close}>Done</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
