import { useCallback, useEffect, useState } from 'react';
import {
  Button as HeroUIButton,
  Input,
  Label,
  Modal,
  TextField
} from '@heroui/react';
import { Network, RefreshCw } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Chip, ListBox, ListBoxItem, Select, Text } from '@/app/dotnaos-ui';
import {
  tailscaleDeviceClassifications,
  type TailscaleDeviceClassification as TailscaleClassification,
  type TailscaleInventoryDevice,
  type TailscaleInventoryResult,
  type TailscaleInventorySourceKind,
  type TailscaleProviderConnectionResult
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

function safeVerifiedAt(value: string | undefined) {
  if (!value) return 'Not yet verified';
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 'Verified' : `Verified ${new Date(timestamp).toLocaleString()}`;
}

export function TailscaleDeviceClassification() {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<TailscaleInventoryResult>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [connection, setConnection] = useState<TailscaleProviderConnectionResult>();
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [connectionSaving, setConnectionSaving] = useState(false);
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

  const loadConnection = useCallback(async () => {
    setConnectionLoading(true);
    setConnectionError('');
    try {
      setConnection(await projectSpaceClient.getTailscaleProviderConnection());
    } catch {
      setConnectionError('The saved Tailscale connection could not be checked. Try again later.');
    } finally {
      setConnectionLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadConnection();
      void load(true);
    }
  }, [load, loadConnection, open]);

  const connect = useCallback(async () => {
    const trimmedClientId = clientId.trim();
    if (!trimmedClientId || !clientSecret) {
      setConnectionError('Enter both the Client ID and Client secret to connect this account.');
      return;
    }
    const request = { clientId: trimmedClientId, clientSecret };
    setClientSecret('');
    setConnectionSaving(true);
    setConnectionError('');
    try {
      setConnection(await projectSpaceClient.connectTailscaleProvider(request));
      setClientId('');
      await load(true);
    } catch {
      setConnectionError('Tailscale could not verify this connection. Check the account and required scope, then try again.');
    } finally {
      setConnectionSaving(false);
    }
  }, [clientId, clientSecret, load]);

  const disconnect = useCallback(async () => {
    setConnectionSaving(true);
    setConnectionError('');
    try {
      setConnection(await projectSpaceClient.revokeTailscaleProviderConnection());
      await Promise.all([loadConnection(), load(true)]);
    } catch {
      setConnectionError('The saved Project Space connection could not be removed. Try again later.');
    } finally {
      setConnectionSaving(false);
    }
  }, [load, loadConnection]);

  const close = useCallback(() => {
    setClientSecret('');
    setConnectionError('');
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

  const source = connection?.source ?? inventory?.provider.source;
  const sourceLabel = providerSourceLabel(source);
  const isApiConnection = source === 'tailscale_oauth_api' && connection?.connectionState === 'connected';
  const needsConnection = connection?.connectionState === 'not_connected'
    || connection?.connectionState === 'reauthorization_required'
    || connection?.connectionState === 'legacy';

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
                {connectionLoading ? <Text className="mb-4 block text-xs text-neutral-500">Checking this account’s Tailscale connection…</Text> : null}
                {isApiConnection ? (
                  <div className="mb-4 border-y border-sky-500/20 py-3">
                    <Text className="block text-sm font-medium text-neutral-100">Connected to Tailscale API</Text>
                    <Text className="mt-1 block text-xs text-neutral-500">{safeVerifiedAt(connection?.verifiedAt)}. This connection is scoped to the current Project Space account.</Text>
                    <Text className="mt-2 block text-xs text-neutral-500">Disconnect removes this saved Project Space connection. It does not revoke the Tailscale OAuth client; revoke that separately in the Tailscale admin console.</Text>
                    <HeroUIButton className="mt-3" isDisabled={connectionSaving} onPress={() => void disconnect()} size="sm" variant="danger">
                      {connectionSaving ? 'Disconnecting…' : 'Disconnect'}
                    </HeroUIButton>
                  </div>
                ) : null}
                {connection?.connectionState === 'legacy' ? (
                  <div className="mb-4 border-y border-amber-500/20 py-3">
                    <Text className="block text-sm font-medium text-neutral-100">Temporary VPS local Tailscale</Text>
                    <Text className="mt-1 block text-xs text-neutral-500">This is a temporary server-local inventory source. It is not a Tailscale API connection for this account.</Text>
                  </div>
                ) : null}
                {needsConnection ? (
                  <form className="mb-4 grid gap-3 border-y border-neutral-800 py-4" onSubmit={(event) => {
                    event.preventDefault();
                    void connect();
                  }}>
                    <div>
                      <Text className="block text-sm font-medium text-neutral-100">Connect this account’s Tailscale API</Text>
                      <Text className="mt-1 block text-xs leading-5 text-neutral-500">Ask a tailnet administrator to create a scoped OAuth client for this account. Project Space needs only <span className="font-mono text-neutral-300">devices:core:read</span>.</Text>
                    </div>
                    <TextField fullWidth isDisabled={connectionSaving} onChange={setClientId} value={clientId}>
                      <Label>Client ID</Label>
                      <Input autoComplete="off" className="w-full font-mono text-xs" variant="secondary" />
                    </TextField>
                    <TextField fullWidth isDisabled={connectionSaving} onChange={setClientSecret} value={clientSecret}>
                      <Label>Client secret</Label>
                      <Input autoComplete="off" className="w-full font-mono text-xs" type="password" variant="secondary" />
                      <Text className="mt-1 block text-xs text-neutral-500">The secret is sent only to verify and save this connection. It is cleared from this form immediately after submission.</Text>
                    </TextField>
                    <div className="flex flex-wrap items-center gap-3">
                      <HeroUIButton isDisabled={connectionSaving || !clientId.trim() || !clientSecret} size="sm" type="submit" variant="primary">
                        {connectionSaving ? 'Connecting…' : 'Connect Tailscale API'}
                      </HeroUIButton>
                      <a className="text-xs text-sky-300 underline-offset-4 hover:underline" href="https://login.tailscale.com/admin/settings/oauth" rel="noreferrer" target="_blank">Open Tailscale admin console</a>
                    </div>
                  </form>
                ) : null}
                {connectionError ? <div role="alert" className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/[.07] px-3 py-2 text-xs text-amber-100">{connectionError}</div> : null}
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
