import { useState } from 'react';
import { AlertTriangle, LoaderCircle, Square } from 'lucide-react';
import { AlertDialog } from '@heroui/react';
import { Button, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import type { MachineRecord } from '@/shared/project-space-api';
import {
  canStopSourceDevelopmentMachineRuntime,
  runtimeUnavailableReason,
  shouldShowMachineRuntimeStop
} from './machine-connector-runtime-model';
import { connectorInstallationLabel } from './machine-connector-topology-model';

export function SettingsMachineRuntimeStop({
  machine,
  onStopped
}: {
  machine: MachineRecord;
  onStopped(): Promise<unknown>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [error, setError] = useState('');

  if (!shouldShowMachineRuntimeStop(machine)) return null;
  const canStop = canStopSourceDevelopmentMachineRuntime(machine);
  const connectorIdentity = connectorInstallationLabel(machine);

  async function stop() {
    setIsStopping(true);
    setError('');
    try {
      await projectSpaceClient.stopMachineRuntime(machine.id);
      setIsOpen(false);
      await onStopped();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The Dev connector could not be stopped.');
    } finally {
      setIsStopping(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        isDisabled={!canStop}
        title={canStop ? undefined : runtimeUnavailableReason(machine, 'stop')}
        onPress={() => setIsOpen(true)}
      >
        <Square className="size-3" />
        Stop
      </Button>
      <AlertDialog
        isOpen={isOpen}
        onOpenChange={(open) => { if (!open && !isStopping) setIsOpen(false); }}
      >
        <AlertDialog.Backdrop
          isDismissable={false}
          isKeyboardDismissDisabled={isStopping}
          variant="blur"
          className="z-[90] bg-black/75"
        >
          <AlertDialog.Container placement="auto" size="md" className="px-3 py-3 sm:px-5 sm:py-6">
            <AlertDialog.Dialog className="border border-neutral-800 bg-neutral-950 text-neutral-100">
              <AlertDialog.Header>
                <AlertDialog.Icon status="warning"><AlertTriangle className="size-5" /></AlertDialog.Icon>
                <AlertDialog.Heading>Stop this Dev connector?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <Text className="block text-sm leading-6 text-neutral-300">
                  Only {connectorIdentity} will stop. Stable and production connectors on the same
                  physical machine are not affected.
                </Text>
                {error ? <Text className="mt-3 block text-xs text-red-300">{error}</Text> : null}
              </AlertDialog.Body>
              <AlertDialog.Footer className="flex-col-reverse gap-2 min-[420px]:flex-row min-[420px]:justify-end">
                <Button variant="ghost" isDisabled={isStopping} onPress={() => setIsOpen(false)}>
                  Cancel
                </Button>
                <Button variant="danger" isDisabled={isStopping} onPress={() => void stop()}>
                  {isStopping ? <LoaderCircle className="size-4 animate-spin" /> : <Square className="size-4" />}
                  {isStopping ? 'Stopping…' : 'Stop Dev connector'}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </>
  );
}
