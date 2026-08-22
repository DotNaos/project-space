import { useEffect, useMemo, useState } from 'react';
import { Button, Container, Icon, Input, Spinner, Text } from '@dotnaos/ui/base';
import { Drawer } from '../../../components/ui/drawer';
import { SearchableSelect } from '../../../components/ui/searchable-select';
import type { ProjectCliHost } from '@/shared/compute-inventory-cli-api';
import type { TailscaleInventoryDevice } from '@/shared/tailscale-inventory-api';
import type { TailnetHostAssignmentDraft } from '../hooks/use-tailnet-compute-inventory';
import { tailnetMachineName } from './machines-page-model';

const createHostValue = '__create_host__';

export function TailnetHostAssignmentDrawer({
  device,
  disabled,
  hosts,
  onAssign,
  onClose,
}: {
  device?: TailscaleInventoryDevice;
  disabled: boolean;
  hosts: readonly ProjectCliHost[];
  onAssign(device: TailscaleInventoryDevice, request: TailnetHostAssignmentDraft): Promise<unknown>;
  onClose(): void;
}) {
  const [selection, setSelection] = useState(createHostValue);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const options = useMemo(() => [
    { label: 'Create new Host', value: createHostValue },
    ...hosts.map((host) => ({ label: host.name, value: host.id }))
  ], [hosts]);

  useEffect(() => {
    setSelection(device?.hostId ?? createHostValue);
    setName(device ? tailnetMachineName(device) : '');
    setError('');
  }, [device?.hostAssignmentRevision, device?.hostId, device?.id]);

  if (!device) return null;

  const machineName = tailnetMachineName(device);
  const unchanged = Boolean(device.hostId && selection === device.hostId);
  const invalidName = selection === createHostValue && !name.trim();

  async function save(request: TailnetHostAssignmentDraft) {
    if (pending || disabled || !device) return;
    setPending(true);
    setError('');
    try {
      await onAssign(device, request);
      onClose();
    } catch {
      setError('The Host assignment was not saved. Refresh and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Drawer
      closeLabel={`Close Host assignment for ${machineName}`}
      dismissible={!pending}
      label={`${device.hostId ? 'Move' : 'Assign'} ${machineName}`}
      onClose={onClose}
      open
      width="medium"
    >
      <Drawer.Header>
        <Container.Stack direction="horizontal" align="center" gap={2}>
          <Icon color="accent" name="box" size="m" />
          <div>
            <h2 className="text-lg font-semibold text-text">
              {device.hostId ? 'Move device' : 'Assign device'}
            </h2>
            <Text color="muted" size="s" text={machineName} />
          </div>
        </Container.Stack>
      </Drawer.Header>

      <Drawer.Body>
        <Container.Stack gap={4} customize={{
          reason: 'Keep device evidence and Host selection clearly separated in the assignment drawer.',
          className: 'min-w-0'
        }}>
          {device.addresses.length > 0 ? (
            <Container.Stack direction="horizontal" align="start" gap={2} customize={{
              reason: 'Allow Tailnet addresses to wrap without widening the drawer.',
              className: 'min-w-0 border-b border-border/70 pb-4'
            }}>
              <Icon color="text" name="globe" size="s" />
              <div className="min-w-0">
                {device.addresses.map((address) => (
                  <span key={address} className="block break-all font-mono text-xs text-text-muted">{address}</span>
                ))}
              </div>
            </Container.Stack>
          ) : null}

          <div>
            <Text color="muted" size="s" text="Host" />
            <div className="mt-2">
              <SearchableSelect
                accessibilityLabel={`Host for ${machineName}`}
                disabled={disabled || pending}
                fullWidth
                onValueChange={setSelection}
                options={options}
                placeholder="Search Hosts"
                size="sm"
                value={selection}
              />
            </div>
          </div>

          {selection === createHostValue ? (
            <div>
              <Text color="muted" size="s" text="New Host name" />
              <div className="mt-2">
                <Input
                  accessibilityLabel="New Host name"
                  disabled={disabled || pending}
                  fullWidth
                  onValueChange={setName}
                  placeholder="Host name"
                  size="sm"
                  value={name}
                />
              </div>
              <p className="mt-2 text-xs text-text-muted">This is how the physical machine appears across Project Space.</p>
            </div>
          ) : null}

          {error ? <p role="alert" className="text-xs text-warning">{error}</p> : null}
        </Container.Stack>
      </Drawer.Body>

      <Drawer.Footer>
        <Container.Stack direction="horizontal" align="center" justify="between" gap={2} customize={{
          reason: 'Separate the optional removal action from the assignment confirmation.',
          className: 'w-full flex-wrap'
        }}>
          <div>
            {device.hostId ? (
              <Button
                disabled={disabled || pending}
                label="Remove from Host"
                onPress={() => void save({ action: 'unassign' })}
                variant="ghost"
              />
            ) : null}
          </div>
          <Container.Stack direction="horizontal" align="center" gap={2}>
            {pending ? <Spinner size="s" /> : null}
            <Button disabled={pending} label="Cancel" onPress={onClose} variant="ghost" />
            <Button
              disabled={disabled || pending || unchanged || invalidName}
              icon={device.hostId ? 'arrow-right' : 'plus'}
              label={device.hostId ? 'Move device' : 'Assign device'}
              onPress={() => void save(selection === createHostValue
                ? { action: 'create', name: name.trim() }
                : { action: 'assign', hostId: selection })}
              variant="primary"
            />
          </Container.Stack>
        </Container.Stack>
      </Drawer.Footer>
    </Drawer>
  );
}
