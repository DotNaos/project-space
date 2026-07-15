import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CircleEllipsis,
  Info,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  RotateCw,
  Square,
  Wrench
} from 'lucide-react';
import { Dropdown } from '@heroui/react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  ConnectorRuntimeOperationName,
  MachineRecord,
  MachineRuntimeStatusResult
} from '@/shared/project-space-api';
import { cn } from '@/lib/utils';
import {
  MachineConnectorActionsDialogs,
  type ConnectorDialogView
} from './machine-connector-actions-dialogs';
import {
  canRestartMachineRuntime,
  canStopSourceDevelopmentMachineRuntime,
  canUpdateMachineRuntime,
  latestRuntimeFailure,
  runtimeApprovedReleaseId,
  runtimeOperationLabel,
  runtimeRetryOperation,
  runtimeStateLabel,
  runtimeUnavailableReason,
  runtimeVersionLabel,
  shouldPollRuntimeStatus,
  shouldShowMachineRuntimeRestart,
  shouldShowMachineRuntimeStop,
  shouldShowMachineRuntimeUpdate
} from './machine-connector-runtime-model';

function initialStatus(machine: MachineRecord): MachineRuntimeStatusResult {
  const online = machine.connector.status === 'local' || machine.connector.status === 'online';
  const capabilities = machine.connector.capabilities ?? [];
  const supportsMaintenance = Boolean(machine.connector.runtime) &&
    capabilities.includes('runtime.restart') && capabilities.includes('runtime.update');
  return {
    capabilities,
    machineId: machine.id,
    online,
    runtime: machine.connector.runtime,
    update: machine.connector.update ?? {
      state: online ? supportsMaintenance ? 'checking' : 'unsupported' : 'offline'
    }
  };
}

function withStatus(machine: MachineRecord, status: MachineRuntimeStatusResult): MachineRecord {
  return {
    ...machine,
    connector: {
      ...machine.connector,
      capabilities: status.capabilities,
      runtime: status.runtime,
      status: status.online
        ? machine.connector.status === 'local'
          ? 'local'
          : 'online'
        : 'offline',
      update: status.update
    }
  };
}

function MenuItemContent({
  description,
  icon,
  label
}: {
  description?: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-4 text-neutral-500">{description}</span>
        ) : null}
      </span>
    </span>
  );
}

export function MachineConnectorActionsMenu({
  className,
  machine,
  onOperationSettled,
  trigger = 'icon',
  triggerLabel = 'Manage connector'
}: {
  className?: string;
  machine: MachineRecord;
  onOperationSettled?(): void | Promise<void>;
  trigger?: 'button' | 'icon';
  triggerLabel?: string;
}) {
  const [dialog, setDialog] = useState<ConnectorDialogView>();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [status, setStatus] = useState(() => initialStatus(machine));
  const settledOperationId = useRef('');
  const resolvedMachine = useMemo(() => withStatus(machine, status), [machine, status]);
  const update = resolvedMachine.connector.update;
  const operation = update?.operation;
  const active = shouldPollRuntimeStatus(update);
  const canUpdate = canUpdateMachineRuntime(resolvedMachine);
  const canRestart = canRestartMachineRuntime(resolvedMachine);
  const canStop = canStopSourceDevelopmentMachineRuntime(resolvedMachine);
  const retryOperation = runtimeRetryOperation(resolvedMachine);
  const approvedReleaseId = runtimeApprovedReleaseId(resolvedMachine);
  const lastFailure = latestRuntimeFailure(update);

  useEffect(() => {
    setStatus(initialStatus(machine));
  }, [machine]);

  const refresh = useCallback(async () => {
    try {
      const next = await projectSpaceClient.getMachineRuntime(machine.id);
      setStatus(next);
      setRequestError('');
      if (
        next.update.operation?.state === 'succeeded' &&
        settledOperationId.current !== next.update.operation.id
      ) {
        settledOperationId.current = next.update.operation.id;
        await onOperationSettled?.();
      }
      return next;
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Could not refresh connector state.');
      return undefined;
    }
  }, [machine.id, onOperationSettled]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  async function startOperation(operationName: ConnectorRuntimeOperationName) {
    setIsSubmitting(true);
    setRequestError('');
    try {
      const result = await projectSpaceClient.startMachineRuntimeOperation(machine.id, {
        operation: operationName,
        releaseId: operationName === 'update' ? approvedReleaseId : undefined
      });
      setStatus(result.status);
      setDialog('progress');
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'The connector operation failed.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function stopDevelopmentConnector() {
    setIsSubmitting(true);
    setRequestError('');
    try {
      await projectSpaceClient.stopMachineRuntime(machine.id);
      setDialog(undefined);
      await onOperationSettled?.();
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : 'The connector could not be stopped.'
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  const showUpdate = shouldShowMachineRuntimeUpdate(resolvedMachine);
  const showRestart = shouldShowMachineRuntimeRestart(resolvedMachine);
  const showStop = shouldShowMachineRuntimeStop(resolvedMachine);
  const updateLabel = retryOperation === 'update'
    ? 'Retry update'
    : `Update to ${update?.availableVersion ?? approvedReleaseId ?? 'approved release'}`;
  const restartLabel = retryOperation === 'restart' ? 'Retry restart' : 'Restart connector';

  return (
    <>
      <Dropdown
        isOpen={isMenuOpen}
        onOpenChange={(open) => {
          setIsMenuOpen(open);
          if (open) void refresh();
        }}
      >
        <Dropdown.Trigger
          aria-label={`${triggerLabel} for ${machine.name}`}
          className={cn(
            'inline-flex items-center justify-center border border-transparent text-neutral-400 outline-none transition focus-visible:ring-2 focus-visible:ring-sky-400/60',
            trigger === 'icon'
              ? 'size-8 rounded-lg hover:border-neutral-800 hover:bg-neutral-900 hover:text-neutral-100'
              : 'min-h-9 w-full gap-2 rounded-lg bg-neutral-100 px-3 text-xs font-medium text-neutral-950 hover:bg-white sm:w-auto',
            className
          )}
        >
          {trigger === 'icon' ? (
            <MoreHorizontal className="size-4" />
          ) : (
            <Wrench className="size-3.5" />
          )}
          {trigger === 'button' ? triggerLabel : null}
        </Dropdown.Trigger>
        <Dropdown.Popover
          offset={8}
          placement="bottom end"
          className="z-[70] w-[min(19rem,calc(100vw-1.5rem))] !max-w-[calc(100vw-1.5rem)] border border-neutral-800 bg-neutral-950 p-1 text-neutral-100 shadow-2xl shadow-black/60"
        >
          <Dropdown.Menu aria-label={`Connector actions for ${machine.name}`}>
            <Dropdown.Item
              id="details"
              textValue="View version details"
              onAction={() => setDialog('details')}
            >
              <MenuItemContent
                icon={<Info className="size-4" />}
                label="View version details"
                description={`${runtimeVersionLabel(resolvedMachine)} · ${runtimeStateLabel(update?.state)}`}
              />
            </Dropdown.Item>
            {active || operation ? (
              <Dropdown.Item
                id="progress"
                textValue={active ? 'View progress' : 'View last operation'}
                onAction={() => setDialog('progress')}
              >
                <MenuItemContent
                  icon={active
                    ? <LoaderCircle className="size-4 animate-spin" />
                    : <CircleEllipsis className="size-4" />}
                  label={active
                    ? runtimeOperationLabel(operation) || 'View progress'
                    : 'View last operation'}
                />
              </Dropdown.Item>
            ) : null}
            {showUpdate ? (
              <Dropdown.Item
                id="update"
                isDisabled={!canUpdate}
                textValue={updateLabel}
                onAction={() => setDialog('confirm-update')}
              >
                <MenuItemContent
                  icon={<RefreshCw className="size-4" />}
                  label={updateLabel}
                  description={canUpdate ? undefined : runtimeUnavailableReason(resolvedMachine, 'update')}
                />
              </Dropdown.Item>
            ) : null}
            {showRestart ? (
              <Dropdown.Item
                id="restart"
                isDisabled={!canRestart}
                textValue={restartLabel}
                onAction={() => setDialog('confirm-restart')}
              >
                <MenuItemContent
                  icon={<RotateCw className="size-4" />}
                  label={restartLabel}
                  description={canRestart
                    ? undefined
                    : runtimeUnavailableReason(resolvedMachine, 'restart')}
                />
              </Dropdown.Item>
            ) : null}
            {showStop ? (
              <Dropdown.Item
                id="stop"
                isDisabled={!canStop}
                textValue="Stop development connector"
                variant="danger"
                onAction={() => setDialog('confirm-stop')}
              >
                <MenuItemContent
                  icon={<Square className="size-4" />}
                  label="Stop development connector"
                  description={canStop
                    ? undefined
                    : runtimeUnavailableReason(resolvedMachine, 'stop')}
                />
              </Dropdown.Item>
            ) : null}
            {lastFailure ? (
              <Dropdown.Item
                id="failure"
                textValue="View last failure"
                variant="danger"
                onAction={() => setDialog('failure')}
              >
                <MenuItemContent
                  icon={<AlertTriangle className="size-4" />}
                  label="View last failure"
                />
              </Dropdown.Item>
            ) : null}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      <MachineConnectorActionsDialogs
        isSubmitting={isSubmitting}
        machine={resolvedMachine}
        onClose={() => setDialog(undefined)}
        onRefresh={() => void refresh()}
        onShowConfirmation={(operationName) =>
          setDialog(operationName === 'update' ? 'confirm-update' : 'confirm-restart')}
        onStart={(operationName) => void startOperation(operationName)}
        onStop={() => void stopDevelopmentConnector()}
        requestError={requestError}
        status={status}
        view={dialog}
      />
    </>
  );
}
