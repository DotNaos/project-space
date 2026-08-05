import { useMemo, useState } from 'react';
import { Check, Monitor, Plus, X } from 'lucide-react';
import { Input, Modal } from '@heroui/react';
import { Button, Text } from '@/app/dotnaos-ui';
import type {
  ConnectorInstallationRecord,
  PhysicalMachineRecord,
  PhysicalMachineSaveRequest
} from '@/shared/project-space-api';
import { ConnectorChannelChip } from './connector-channel-chip';
import { MachineOsMark } from './machine-visuals';

const NEW_MACHINE = '__new_machine__';

export function SettingsConnectorMachineEditor({
  connector,
  onClose,
  onSave,
  physicalMachines
}: {
  connector: ConnectorInstallationRecord;
  onClose(): void;
  onSave(request: PhysicalMachineSaveRequest): Promise<void>;
  physicalMachines: readonly PhysicalMachineRecord[];
}) {
  const currentMachine = useMemo(
    () => physicalMachines.find((machine) => machine.connectorIds.includes(connector.id)),
    [connector.id, physicalMachines]
  );
  const [machineId, setMachineId] = useState(currentMachine?.id ?? NEW_MACHINE);
  const [newMachineName, setNewMachineName] = useState(connector.name);
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const selectedMachine = physicalMachines.find((machine) => machine.id === machineId);
  const canSave = machineId === NEW_MACHINE
    ? Boolean(newMachineName.trim())
    : Boolean(selectedMachine);

  async function save() {
    if (!canSave) return;
    setIsSaving(true);
    setError('');
    try {
      await onSave(selectedMachine ? {
        connectorIds: [...new Set([...selectedMachine.connectorIds, connector.id])],
        id: selectedMachine.id,
        name: selectedMachine.name
      } : {
        connectorIds: [connector.id],
        name: newMachineName.trim()
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The connector could not be assigned.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Backdrop variant="blur" className="z-[80] bg-black/75">
        <Modal.Container placement="center" size="md" className="p-3">
          <Modal.Dialog className="border border-neutral-800 bg-neutral-950 text-neutral-100">
            <Modal.Header className="flex-row items-center gap-3 border-b border-neutral-900">
              <div className="min-w-0 flex-1">
                <Modal.Heading>Edit connector</Modal.Heading>
                <span className="mt-1 flex min-w-0 items-center gap-2">
                  <MachineOsMark machine={connector} />
                  <Text className="truncate text-xs text-neutral-500">{connector.name}</Text>
                  <ConnectorChannelChip machine={connector} />
                </span>
              </div>
              <Button aria-label="Close" isIconOnly size="sm" variant="ghost" onPress={onClose}>
                <X className="size-4" />
              </Button>
            </Modal.Header>
            <Modal.Body className="space-y-4">
              <div>
                <Text className="mb-2 block text-xs font-medium text-neutral-300">Machine</Text>
                <div className="space-y-1">
                  {physicalMachines.map((machine) => {
                    const isSelected = machine.id === machineId;
                    return (
                      <button
                        key={machine.id}
                        aria-pressed={isSelected}
                        className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition hover:bg-neutral-900 focus-visible:ring-2 focus-visible:ring-sky-400/60 aria-pressed:bg-neutral-800"
                        type="button"
                        onClick={() => setMachineId(machine.id)}
                      >
                        <Monitor className="size-4 shrink-0 text-neutral-500" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-neutral-100">{machine.name}</span>
                          <span className="block truncate text-xs text-neutral-500">
                            {machine.connectorIds.length} connector{machine.connectorIds.length === 1 ? '' : 's'}
                          </span>
                        </span>
                        {isSelected ? <Check className="size-4 shrink-0 text-sky-400" /> : null}
                      </button>
                    );
                  })}
                  <button
                    aria-pressed={machineId === NEW_MACHINE}
                    className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition hover:bg-neutral-900 focus-visible:ring-2 focus-visible:ring-sky-400/60 aria-pressed:bg-neutral-800"
                    type="button"
                    onClick={() => setMachineId(NEW_MACHINE)}
                  >
                    <Plus className="size-4 shrink-0 text-neutral-500" />
                    <span className="min-w-0 flex-1 text-sm text-neutral-100">New machine</span>
                    {machineId === NEW_MACHINE ? <Check className="size-4 shrink-0 text-sky-400" /> : null}
                  </button>
                </div>
              </div>
              {machineId === NEW_MACHINE ? (
                <label className="block">
                  <Text className="mb-1.5 block text-xs font-medium text-neutral-300">Machine name</Text>
                  <Input
                    autoFocus
                    fullWidth
                    placeholder="os-pc"
                    value={newMachineName}
                    variant="secondary"
                    onChange={(event) => setNewMachineName(event.currentTarget.value)}
                  />
                </label>
              ) : null}
              {currentMachine && currentMachine.id !== machineId ? (
                <Text className="block text-xs text-amber-300/80">
                  Saving moves this connector from {currentMachine.name}.
                </Text>
              ) : null}
              {error ? <Text className="block text-xs text-red-300">{error}</Text> : null}
            </Modal.Body>
            <Modal.Footer className="gap-2">
              <Button variant="ghost" onPress={onClose}>Cancel</Button>
              <Button isDisabled={!canSave || isSaving} variant="primary" onPress={() => void save()}>
                {isSaving ? 'Saving…' : 'Save connector'}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
