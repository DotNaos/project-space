import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleEllipsis,
  Info,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  RotateCw,
  Wrench,
  X
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownPopover,
  DropdownTrigger,
  Text
} from '@/app/dotnaos-ui';
import type {
  MachineRecord,
  MachineRuntimeOperationRequest,
  MachineRuntimeOperationResult,
  MachineRuntimeStatusResult
} from '@/shared/project-space-api';
import { cn } from '@/lib/utils';
import { formatOptionalTime } from './project-main-model';
import {
  canRestartMachineRuntime,
  canUpdateMachineRuntime,
  isRuntimeBusy,
  runtimeOperationLabel,
  runtimeStateLabel,
  runtimeUnavailableReason,
  runtimeVersionLabel
} from './machine-connector-runtime-model';

type DialogView = 'confirm-restart' | 'confirm-update' | 'details' | 'failure' | 'progress';

interface RuntimeClient {
  getMachineRuntime(machineId: string): Promise<MachineRuntimeStatusResult>;
  startMachineRuntimeOperation(
    machineId: string,
    request: MachineRuntimeOperationRequest
  ): Promise<MachineRuntimeOperationResult>;
}

const runtimeClient = projectSpaceClient as unknown as RuntimeClient;

function initialStatus(machine: MachineRecord): MachineRuntimeStatusResult {
  const online = machine.connector.status === 'local' || machine.connector.status === 'online';
  return {
    capabilities: machine.connector.capabilities ?? [],
    machineId: machine.id,
    online,
    runtime: machine.connector.runtime,
    update: machine.connector.update ?? { state: online ? 'unknown' : 'offline' }
  };
}

function withStatus(machine: MachineRecord, status: MachineRuntimeStatusResult): MachineRecord {
  return {
    ...machine,
    connector: {
      ...machine.connector,
      capabilities: status.capabilities,
      runtime: status.runtime,
      status: status.online ? machine.connector.status === 'local' ? 'local' : 'online' : 'offline',
      update: status.update
    }
  };
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(7rem,0.7fr)_minmax(0,1.3fr)] gap-3 border-b border-neutral-900/80 py-2.5 last:border-0">
      <Text className="text-xs font-medium text-neutral-500">{label}</Text>
      <Text className="min-w-0 break-words text-right text-sm text-neutral-200">{value}</Text>
    </div>
  );
}

function ConnectorDialog({
  children,
  isBusy,
  onClose,
  title
}: {
  children: ReactNode;
  isBusy?: boolean;
  onClose(): void;
  title: string;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !isBusy) onClose();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isBusy, onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 px-3 py-3 sm:items-center sm:px-5 sm:py-6"
      onClick={() => {
        if (!isBusy) onClose();
      }}
    >
      <section
        aria-modal="true"
        aria-label={title}
        role="dialog"
        className="flex max-h-[min(42rem,calc(100dvh-1.5rem))] w-full max-w-lg flex-col overflow-hidden rounded-t-xl border border-neutral-800 bg-neutral-950 shadow-2xl sm:rounded-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-neutral-900 px-4 py-3.5">
          <Text className="text-base font-semibold text-neutral-100">{title}</Text>
          <Button
            aria-label="Close connector dialog"
            className="size-8 shrink-0 rounded-lg border-transparent p-0 text-neutral-400"
            isDisabled={isBusy}
            onPress={onClose}
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4">{children}</div>
      </section>
    </div>
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
  const [dialog, setDialog] = useState<DialogView>();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [status, setStatus] = useState(() => initialStatus(machine));
  const settledOperationId = useRef('');
  const resolvedMachine = useMemo(() => withStatus(machine, status), [machine, status]);
  const update = resolvedMachine.connector.update;
  const runtime = resolvedMachine.connector.runtime;
  const operation = update?.operation;
  const active = isRuntimeBusy(update);
  const canUpdate = canUpdateMachineRuntime(resolvedMachine);
  const canRestart = canRestartMachineRuntime(resolvedMachine);

  useEffect(() => {
    setStatus(initialStatus(machine));
  }, [machine]);

  const refresh = useCallback(async () => {
    try {
      const next = await runtimeClient.getMachineRuntime(machine.id);
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
    if (!active && dialog !== 'progress') return;
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(timer);
  }, [active, dialog, refresh]);

  async function startOperation(operationName: 'restart' | 'update') {
    setIsSubmitting(true);
    setRequestError('');
    try {
      const result = await runtimeClient.startMachineRuntimeOperation(machine.id, {
        operation: operationName,
        releaseId:
          operationName === 'update' ? resolvedMachine.connector.update?.availableReleaseId : undefined
      });
      setStatus(result.status);
      setDialog('progress');
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'The connector operation failed.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const showUpdate =
    Boolean(update?.availableReleaseId) ||
    update?.state === 'update-available' ||
    update?.state === 'update-required' ||
    update?.state === 'failed';
  const lastFailure = update?.lastFailure ?? operation?.lastFailure;
  const closeDialog = useCallback(() => setDialog(undefined), []);

  return (
    <>
      <Dropdown
        open={isMenuOpen}
        onOpenChange={(open) => {
          setIsMenuOpen(open);
          if (open) void refresh();
        }}
      >
        <DropdownTrigger
          aria-label={`${triggerLabel} for ${machine.name}`}
          className={cn(
            trigger === 'icon'
              ? 'size-8 rounded-lg border-transparent text-neutral-500 hover:border-neutral-800 hover:text-neutral-100'
              : 'min-h-8 gap-2 rounded-lg px-3 text-xs font-medium',
            className
          )}
        >
          {trigger === 'icon' ? <MoreHorizontal className="size-4" /> : <Wrench className="size-3.5" />}
          {trigger === 'button' ? triggerLabel : null}
        </DropdownTrigger>
        <DropdownPopover
          className="w-76"
          style={{
            maxWidth: 'calc(100vw - 1.5rem)',
            minWidth: 0,
            width: '19rem'
          }}
        >
          <DropdownMenu aria-label={`Connector actions for ${machine.name}`}>
            <DropdownItem onPress={() => setDialog('details')}>
              <span className="flex items-center gap-2">
                <Info className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block">View version details</span>
                  <span className="mt-0.5 block truncate text-xs text-neutral-500">
                    {runtimeVersionLabel(resolvedMachine)} · {runtimeStateLabel(update?.state)}
                  </span>
                </span>
              </span>
            </DropdownItem>
            {active || operation ? (
              <DropdownItem onPress={() => setDialog('progress')}>
                <span className="flex items-center gap-2">
                  {active ? <LoaderCircle className="size-4 animate-spin" /> : <CircleEllipsis className="size-4" />}
                  <span>{active ? runtimeOperationLabel(operation) || 'View progress' : 'View last operation'}</span>
                </span>
              </DropdownItem>
            ) : null}
            {showUpdate ? (
              <DropdownItem
                isDisabled={!canUpdate}
                title={canUpdate ? undefined : runtimeUnavailableReason(resolvedMachine, 'update')}
                onPress={() => setDialog('confirm-update')}
              >
                <span className="flex items-center gap-2">
                  <RefreshCw className="size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block">
                      {update?.state === 'failed' ? 'Retry update' : `Update to ${update?.availableVersion ?? 'approved release'}`}
                    </span>
                    {!canUpdate ? (
                      <span className="mt-0.5 block text-xs text-neutral-600">
                        {runtimeUnavailableReason(resolvedMachine, 'update')}
                      </span>
                    ) : null}
                  </span>
                </span>
              </DropdownItem>
            ) : null}
            <DropdownItem
              isDisabled={!canRestart}
              title={canRestart ? undefined : runtimeUnavailableReason(resolvedMachine, 'restart')}
              onPress={() => setDialog('confirm-restart')}
            >
              <span className="flex items-center gap-2">
                <RotateCw className="size-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block">Restart connector</span>
                  {!canRestart ? (
                    <span className="mt-0.5 block text-xs text-neutral-600">
                      {runtimeUnavailableReason(resolvedMachine, 'restart')}
                    </span>
                  ) : null}
                </span>
              </span>
            </DropdownItem>
            {lastFailure ? (
              <DropdownItem onPress={() => setDialog('failure')}>
                <span className="flex items-center gap-2 text-red-300">
                  <AlertTriangle className="size-4" />
                  View last failure
                </span>
              </DropdownItem>
            ) : null}
          </DropdownMenu>
        </DropdownPopover>
      </Dropdown>

      {dialog === 'details' ? (
        <ConnectorDialog onClose={closeDialog} title={`${machine.name} connector`}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <Text className="block text-lg font-semibold text-neutral-100">
                {runtimeVersionLabel(resolvedMachine)}
              </Text>
              <Text className="mt-0.5 block text-xs text-neutral-500">
                {runtimeStateLabel(update?.state)}
              </Text>
            </div>
            <Button size="sm" variant="secondary" onPress={() => void refresh()}>
              <RefreshCw className="size-3.5" /> Refresh
            </Button>
          </div>
          <DetailRow label="Release" value={runtime?.releaseId ?? 'Unknown'} />
          <DetailRow label="Build" value={runtime?.buildId ?? 'Unknown'} />
          <DetailRow label="Protocol" value={runtime?.protocolVersion ?? 'Unknown'} />
          <DetailRow label="Platform" value={runtime ? `${runtime.platform} · ${runtime.architecture}` : 'Unknown'} />
          <DetailRow label="Channel" value={runtime ? `${runtime.channel} · ${runtime.source}` : 'Unknown'} />
          <DetailRow label="Last checked" value={formatOptionalTime(runtime?.lastCheckedAt)} />
          <DetailRow label="Connector" value={runtime?.bundleVersions.connector ?? 'Unknown'} />
          <DetailRow label="Machine tools" value={runtime?.bundleVersions.machineTools ?? 'Unknown'} />
          <DetailRow label="Project CLI" value={runtime?.bundleVersions.projectCli ?? 'Unknown'} />
          <DetailRow
            label="Capabilities"
            value={status.capabilities.length > 0 ? status.capabilities.join(', ') : 'None reported'}
          />
          {requestError ? <Text className="mt-3 block text-xs text-red-300">{requestError}</Text> : null}
        </ConnectorDialog>
      ) : null}

      {dialog === 'confirm-update' || dialog === 'confirm-restart' ? (
        <ConnectorDialog
          isBusy={isSubmitting}
          onClose={closeDialog}
          title={dialog === 'confirm-update' ? 'Confirm connector update' : 'Confirm connector restart'}
        >
          <Text className="block text-sm leading-6 text-neutral-300">
            {dialog === 'confirm-update'
              ? `Update ${machine.name} from ${runtimeVersionLabel(resolvedMachine)} to ${update?.availableVersion ?? update?.availableReleaseId ?? 'the approved release'}?`
              : `Restart the connector on ${machine.name}? Its installed version will not change.`}
          </Text>
          <div className="my-4 rounded-lg border border-amber-500/25 bg-amber-500/8 p-3">
            <Text className="block text-sm font-medium text-amber-200">Expect a temporary disconnect</Text>
            <Text className="mt-1 block text-xs leading-5 text-amber-200/70">
              Project Space will wait for this machine to reconnect and prove its running version before reporting success.
              {dialog === 'confirm-update' ? ' If health checks fail, the updater will use the available recovery path.' : ''}
            </Text>
          </div>
          {requestError ? <Text className="mb-3 block text-xs text-red-300">{requestError}</Text> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button isDisabled={isSubmitting} variant="secondary" onPress={closeDialog}>Cancel</Button>
            <Button
              isDisabled={isSubmitting}
              variant="primary"
              onPress={() => void startOperation(dialog === 'confirm-update' ? 'update' : 'restart')}
            >
              {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : dialog === 'confirm-update' ? <RefreshCw className="size-4" /> : <RotateCw className="size-4" />}
              {isSubmitting ? 'Starting…' : dialog === 'confirm-update' ? 'Update connector' : 'Restart connector'}
            </Button>
          </div>
        </ConnectorDialog>
      ) : null}

      {dialog === 'progress' ? (
        <ConnectorDialog onClose={closeDialog} title={operation?.operation === 'restart' ? 'Connector restart' : 'Connector update'}>
          <div aria-live="polite" className="flex items-start gap-3">
            {active ? (
              <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-sky-300" />
            ) : operation?.state === 'succeeded' ? (
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-300" />
            ) : (
              <CircleEllipsis className="mt-0.5 size-5 shrink-0 text-neutral-400" />
            )}
            <div className="min-w-0">
              <Text className="block text-sm font-semibold text-neutral-100">
                {runtimeOperationLabel(operation) || runtimeStateLabel(update?.state)}
              </Text>
              <Text className="mt-1 block text-xs leading-5 text-neutral-500">
                {active ? 'You can close this dialog. Progress will remain available after reloading.' : `Running ${runtimeVersionLabel(resolvedMachine)} on ${machine.name}.`}
              </Text>
            </div>
          </div>
          {operation ? (
            <div className="mt-4">
              <DetailRow label="Operation" value={operation.operation} />
              <DetailRow label="Updated" value={formatOptionalTime(operation.updatedAt)} />
              <DetailRow label="Release" value={operation.expectedReleaseId ?? runtime?.releaseId ?? 'Unknown'} />
            </div>
          ) : null}
          {requestError ? <Text className="mt-3 block text-xs text-red-300">{requestError}</Text> : null}
          <Button className="mt-4 w-full sm:w-auto" variant="secondary" onPress={() => void refresh()}>
            <RefreshCw className="size-3.5" /> Check now
          </Button>
        </ConnectorDialog>
      ) : null}

      {dialog === 'failure' && lastFailure ? (
        <ConnectorDialog onClose={closeDialog} title="Last connector failure">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-300" />
            <div className="min-w-0">
              <Text className="block text-sm font-semibold text-neutral-100">{lastFailure.message}</Text>
              <Text className="mt-1 block text-xs text-neutral-500">{lastFailure.code}</Text>
            </div>
          </div>
          <div className="mt-4">
            <DetailRow label="Failed" value={formatOptionalTime(lastFailure.at)} />
            <DetailRow label="Recovery" value={lastFailure.rollbackAvailable ? 'Rollback available' : 'Manual recovery may be required'} />
          </div>
          {canUpdate ? (
            <Button className="mt-4 w-full sm:w-auto" variant="primary" onPress={() => setDialog('confirm-update')}>
              <RefreshCw className="size-4" /> Retry update <ChevronRight className="size-4" />
            </Button>
          ) : null}
        </ConnectorDialog>
      ) : null}
    </>
  );
}
