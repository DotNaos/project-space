import { useMemo, useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import { AlertDialog, Checkbox, Input, Modal } from '@heroui/react';
import { Button, Text } from '@/app/dotnaos-ui';
import type {
  MachineExecutionScopeRecord,
  MachineExecutionScopeSaveRequest,
  MachineRecord
} from '@/shared/project-space-api';
import { ConnectorChannelChip } from './connector-channel-chip';
import { MachineOsMark } from './machine-visuals';

export function SettingsMachineScopeEditor({
  editing,
  machines,
  onClose,
  onSave,
  scopes
}: {
  editing?: MachineExecutionScopeRecord;
  machines: readonly MachineRecord[];
  onClose(): void;
  onSave(request: MachineExecutionScopeSaveRequest): Promise<void>;
  scopes: readonly MachineExecutionScopeRecord[];
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [selected, setSelected] = useState(() => new Set(editing?.machineIds ?? []));
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isConfirmingMoves, setIsConfirmingMoves] = useState(false);
  const scopeByMachineId = useMemo(() => {
    const result = new Map<string, MachineExecutionScopeRecord>();
    for (const scope of scopes) {
      if (scope.id === editing?.id) continue;
      for (const machineId of scope.machineIds) result.set(machineId, scope);
    }
    return result;
  }, [editing?.id, scopes]);
  const movedScopes = useMemo(() => [...new Set(
    [...selected].map((machineId) => scopeByMachineId.get(machineId)).filter(
      (scope): scope is MachineExecutionScopeRecord => Boolean(scope)
    )
  )], [scopeByMachineId, selected]);

  async function persist() {
    if (!name.trim() || selected.size === 0) return;
    setIsSaving(true);
    setError('');
    try {
      await onSave({ id: editing?.id, machineIds: [...selected], name: name.trim() });
      onClose();
    } catch (caught) {
      setIsConfirmingMoves(false);
      setError(caught instanceof Error ? caught.message : 'The machine group could not be saved.');
    } finally {
      setIsSaving(false);
    }
  }

  function save() {
    if (movedScopes.length > 0) setIsConfirmingMoves(true);
    else void persist();
  }

  return (
    <>
      <Modal isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
        <Modal.Backdrop variant="blur" className="z-[80] bg-black/75">
          <Modal.Container placement="center" size="md" className="p-3">
            <Modal.Dialog className="border border-neutral-800 bg-neutral-950 text-neutral-100">
              <Modal.Header className="flex-row items-center gap-3 border-b border-neutral-900">
                <div className="min-w-0 flex-1">
                  <Modal.Heading>{editing ? 'Edit machine group' : 'Group connector instances'}</Modal.Heading>
                  <Text className="mt-1 block text-xs text-neutral-500">
                    Grouping uses connector IDs, never their display names.
                  </Text>
                </div>
                <Button aria-label="Close" isIconOnly size="sm" variant="ghost" onPress={onClose}>
                  <X className="size-4" />
                </Button>
              </Modal.Header>
              <Modal.Body className="space-y-4">
                <label className="block">
                  <Text className="mb-1.5 block text-xs font-medium text-neutral-300">Machine name</Text>
                  <Input autoFocus fullWidth placeholder="os-pc" value={name} variant="secondary" onChange={(event) => setName(event.currentTarget.value)} />
                </label>
                <div>
                  <Text className="mb-2 block text-xs font-medium text-neutral-300">Connector instances</Text>
                  <div className="divide-y divide-neutral-900 rounded-lg border border-neutral-800">
                    {machines.map((machine) => {
                      const currentScope = scopeByMachineId.get(machine.id);
                      return (
                        <Checkbox
                          key={machine.id}
                          className="flex w-full items-center gap-3 px-3 py-3"
                          isSelected={selected.has(machine.id)}
                          onChange={(checked) => setSelected((current) => {
                            const next = new Set(current);
                            if (checked) next.add(machine.id);
                            else next.delete(machine.id);
                            return next;
                          })}
                        >
                          <Checkbox.Control>
                            <Checkbox.Indicator>{({ isSelected }) => isSelected ? <Check className="size-3" /> : null}</Checkbox.Indicator>
                          </Checkbox.Control>
                          <Checkbox.Content className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-2">
                              <MachineOsMark machine={machine} />
                              <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{machine.name}</span>
                              <ConnectorChannelChip machine={machine} />
                            </span>
                            {currentScope ? (
                              <span className="mt-0.5 block truncate text-xs text-amber-300/80">
                                Currently in {currentScope.name}; selecting it will move it.
                              </span>
                            ) : null}
                          </Checkbox.Content>
                        </Checkbox>
                      );
                    })}
                  </div>
                </div>
                {error ? <Text className="block text-xs text-red-300">{error}</Text> : null}
              </Modal.Body>
              <Modal.Footer className="gap-2">
                <Button variant="ghost" onPress={onClose}>Cancel</Button>
                <Button isDisabled={!name.trim() || selected.size === 0 || isSaving} variant="primary" onPress={save}>
                  {isSaving ? 'Saving…' : 'Save group'}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <AlertDialog isOpen={isConfirmingMoves} onOpenChange={(open) => { if (!open && !isSaving) setIsConfirmingMoves(false); }}>
        <AlertDialog.Backdrop isDismissable={false} variant="blur" className="z-[90] bg-black/75">
          <AlertDialog.Container placement="auto" size="md" className="px-3 py-3 sm:px-5 sm:py-6">
            <AlertDialog.Dialog className="border border-neutral-800 bg-neutral-950 text-neutral-100">
              <AlertDialog.Header>
                <AlertDialog.Icon status="warning"><AlertTriangle className="size-5" /></AlertDialog.Icon>
                <AlertDialog.Heading>Move connector instances?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <Text className="block text-sm leading-6 text-neutral-300">
                  Your selection moves connector instances out of {movedScopes.map((scope) => scope.name).join(', ')}.
                  Empty groups will be removed automatically.
                </Text>
                {error ? <Text className="mt-3 block text-xs text-red-300">{error}</Text> : null}
              </AlertDialog.Body>
              <AlertDialog.Footer className="gap-2">
                <Button variant="ghost" isDisabled={isSaving} onPress={() => setIsConfirmingMoves(false)}>Cancel</Button>
                <Button variant="primary" isDisabled={isSaving} onPress={() => void persist()}>
                  {isSaving ? 'Moving…' : 'Move and save'}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </>
  );
}
