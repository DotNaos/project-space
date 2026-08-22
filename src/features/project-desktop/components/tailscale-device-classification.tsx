import { useEffect, useState } from 'react';
import { Container, Select, Spinner, Text } from '@dotnaos/ui/base';
import {
  tailscaleDeviceClassifications,
  type TailscaleDeviceClassification,
  type TailscaleInventoryDevice,
  type TailscaleInventoryResult
} from '@/shared/tailscale-inventory-api';

export const tailscaleClassificationLabels: Record<TailscaleDeviceClassification, string> = {
  console_endpoint: 'Console endpoint',
  deployment_destination: 'Deployment destination',
  environment: 'Environment',
  ignored: 'Ignored',
  unclassified: 'Tailnet only'
};

const classificationOptions = tailscaleDeviceClassifications.map((value) => ({
  label: tailscaleClassificationLabels[value],
  value
}));

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

export function tailnetProviderStatusCopy(
  provider: TailscaleInventoryResult['provider']
): { detail: string; label: string; tone: 'attention' | 'neutral' } | undefined {
  switch (provider.connectionState) {
    case 'configured':
      return {
        detail: 'Refresh devices to verify the deployment credential and load current Tailnet evidence.',
        label: 'Tailscale is configured for this deployment',
        tone: 'neutral'
      };
    case 'legacy':
      return {
        detail: 'This temporary server-local source remains active until deployment-owned OAuth inventory is configured and proven.',
        label: provider.source === 'temporary_vps_local_status'
          ? 'Temporary VPS local Tailscale'
          : 'Temporary Tailnet source',
        tone: 'attention'
      };
    case 'not_configured':
      return {
        detail: 'Configure the deployment’s Tailscale OAuth client through its secret manager.',
        label: 'Tailscale is not configured',
        tone: 'attention'
      };
    case 'scope_insufficient':
      return {
        detail: 'The deployment credential does not have the required devices:core:read scope.',
        label: 'Tailscale inventory access is incomplete',
        tone: 'attention'
      };
    case 'unavailable':
      return {
        detail: 'Tailscale is temporarily unavailable for this deployment.',
        label: 'Tailscale inventory is unavailable',
        tone: 'attention'
      };
    case 'authentication_error':
    case 'configuration_error':
      return {
        detail: 'The deployment’s Tailscale credential could not be used. Update it in the deployment secret manager.',
        label: 'Tailscale inventory needs attention',
        tone: 'attention'
      };
    case 'connected':
      return undefined;
  }
}

export function TailnetProviderStatus({
  provider
}: {
  provider: TailscaleInventoryResult['provider'];
}) {
  const copy = tailnetProviderStatusCopy(provider);
  if (!copy) return null;
  const attention = copy.tone === 'attention';
  return (
    <Container.Stack
      as="aside"
      gap={1}
      padding={3}
      customize={{
        reason: 'Keep provider lifecycle evidence inside the primary inventory without creating a second framed context.',
        className: attention
          ? 'border-y border-amber-500/25 text-amber-100'
          : 'border-y border-sky-500/20 text-sky-100'
      }}
    >
      <Text size="s" text={copy.label} weight="semibold" />
      <Text color="muted" size="s" text={copy.detail} />
    </Container.Stack>
  );
}

export function InlineTailscaleClassification({
  device,
  disabled,
  onClassify
}: {
  device: TailscaleInventoryDevice;
  disabled: boolean;
  onClassify(device: TailscaleInventoryDevice, value: TailscaleDeviceClassification): Promise<unknown>;
}) {
  const [draft, setDraft] = useState(device.classification);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(device.classification);
    setError('');
  }, [device.classification, device.revision]);

  async function save(value: TailscaleDeviceClassification) {
    if (value === device.classification || pending) return;
    setDraft(value);
    setPending(true);
    setError('');
    try {
      await onClassify(device, value);
    } catch {
      setDraft(device.classification);
      setError('Classification was not saved. Refresh and try again.');
    } finally {
      setPending(false);
    }
  }

  const controlDisabled = disabled || pending;

  return (
    <Container.Stack gap={1} fullWidth customize={{ reason: 'Keep inline Tailnet classification compact within an inventory source row.', className: 'min-w-0 sm:max-w-64' }}>
      <Select
        accessibilityLabel={`Classification for ${tailnetDeviceLabel(device)}`}
        disabled={controlDisabled}
        fullWidth
        onValueChange={(value) => {
          if (tailscaleDeviceClassifications.includes(value as TailscaleDeviceClassification)) {
            void save(value as TailscaleDeviceClassification);
          }
        }}
        options={classificationOptions}
        size="sm"
        value={draft}
      />
      {pending ? (
        <Container.Stack direction="horizontal" align="center" gap={1}>
          <Spinner size="s" />
          <Text color="muted" size="s" text="Saving classification…" />
        </Container.Stack>
      ) : null}
      {error ? <p role="alert" className="text-xs text-amber-300">{error}</p> : null}
    </Container.Stack>
  );
}
