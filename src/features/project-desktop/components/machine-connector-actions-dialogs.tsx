import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleEllipsis,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  RotateCw,
  X
} from 'lucide-react';
import { AlertDialog, Button, Modal, ProgressBar } from '@heroui/react';
import type {
  ConnectorRuntimeOperationName,
  MachineRecord,
  MachineRuntimeStatusResult
} from '@/shared/project-space-api';
import { formatOptionalTime } from './project-main-model';
import {
  canRestartMachineRuntime,
  canUpdateMachineRuntime,
  isRuntimeBusy,
  latestRuntimeFailure,
  runtimeOperationLabel,
  runtimeOperationOutcomeMessage,
  runtimeRetryOperation,
  runtimeStateLabel,
  runtimeVersionLabel
} from './machine-connector-runtime-model';

export type ConnectorDialogView =
  | 'confirm-restart'
  | 'confirm-update'
  | 'details'
  | 'failure'
  | 'progress';

interface MachineConnectorActionsDialogsProps {
  isSubmitting: boolean;
  machine: MachineRecord;
  onClose(): void;
  onRefresh(): void;
  onShowConfirmation(operation: ConnectorRuntimeOperationName): void;
  onStart(operation: ConnectorRuntimeOperationName): void;
  requestError: string;
  status: MachineRuntimeStatusResult;
  view?: ConnectorDialogView;
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 border-b border-neutral-900/80 py-2.5 last:border-0 min-[420px]:grid-cols-[minmax(7rem,0.7fr)_minmax(0,1.3fr)] min-[420px]:gap-3">
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      <span className="min-w-0 break-words text-sm text-neutral-200 min-[420px]:text-right">
        {value}
      </span>
    </div>
  );
}

function RequestError({ message }: { message: string }) {
  return message ? (
    <p aria-live="polite" className="mt-3 text-xs leading-5 text-red-300">
      {message}
    </p>
  ) : null;
}

function ConfirmationDialog({
  isSubmitting,
  machine,
  onClose,
  onStart,
  operation,
  requestError
}: Pick<
  MachineConnectorActionsDialogsProps,
  'isSubmitting' | 'machine' | 'onClose' | 'onStart' | 'requestError'
> & { operation?: ConnectorRuntimeOperationName }) {
  const runtime = machine.connector.runtime;
  const update = machine.connector.update;
  const updateTarget = update?.availableVersion ??
    update?.availableReleaseId ??
    update?.operation?.expectedReleaseId ??
    'the approved release';

  return (
    <AlertDialog
      isOpen={Boolean(operation)}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onClose();
      }}
    >
      <AlertDialog.Backdrop
        isDismissable={false}
        isKeyboardDismissDisabled={isSubmitting}
        variant="blur"
        className="z-[80] bg-black/75"
      >
        <AlertDialog.Container placement="auto" size="md" className="px-3 py-3 sm:px-5 sm:py-6">
          <AlertDialog.Dialog className="border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/60">
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning">
                <AlertTriangle className="size-5" />
              </AlertDialog.Icon>
              <AlertDialog.Heading>
                {operation === 'update' ? 'Confirm connector update' : 'Confirm connector restart'}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm leading-6 text-neutral-300">
                {operation === 'update'
                  ? `Update ${machine.name} from ${runtimeVersionLabel(machine)} to ${updateTarget}?`
                  : `Restart the connector on ${machine.name}? Its installed version will not change.`}
              </p>
              <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/8 p-3">
                <p className="text-sm font-medium text-amber-200">Expect a temporary disconnect</p>
                <p className="mt-1 text-xs leading-5 text-amber-200/70">
                  Project Space will wait for this machine to reconnect and prove its running version
                  before reporting success.
                  {operation === 'update' && runtime
                    ? ' If health checks fail, the updater will use the available recovery path.'
                    : ''}
                </p>
              </div>
              <RequestError message={requestError} />
            </AlertDialog.Body>
            <AlertDialog.Footer className="flex-col-reverse gap-2 min-[420px]:flex-row min-[420px]:justify-end">
              <Button
                fullWidth
                isDisabled={isSubmitting}
                variant="secondary"
                onPress={onClose}
                className="min-[420px]:w-auto"
              >
                Cancel
              </Button>
              <Button
                fullWidth
                isDisabled={isSubmitting || !operation}
                variant="primary"
                onPress={() => operation && onStart(operation)}
                className="min-[420px]:w-auto"
              >
                {isSubmitting ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : operation === 'update' ? (
                  <RefreshCw className="size-4" />
                ) : (
                  <RotateCw className="size-4" />
                )}
                {isSubmitting
                  ? 'Starting…'
                  : operation === 'update'
                    ? 'Update connector'
                    : 'Restart connector'}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  );
}

function ProgressIcon({ machine }: { machine: MachineRecord }) {
  const update = machine.connector.update;
  const operation = update?.operation;
  if (isRuntimeBusy(update)) {
    return <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-sky-300" />;
  }
  if (operation?.state === 'succeeded') {
    return <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-300" />;
  }
  if (operation?.state === 'failed' || operation?.state === 'recovery-required') {
    return <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-300" />;
  }
  if (operation?.state === 'rolled-back') {
    return <RotateCcw className="mt-0.5 size-5 shrink-0 text-amber-300" />;
  }
  return <CircleEllipsis className="mt-0.5 size-5 shrink-0 text-neutral-400" />;
}

function modalTitle(view: Exclude<ConnectorDialogView, `confirm-${string}`>, machine: MachineRecord) {
  if (view === 'details') return `${machine.name} connector`;
  if (view === 'failure') return 'Last connector failure';
  return machine.connector.update?.operation?.operation === 'restart'
    ? 'Connector restart'
    : 'Connector update';
}

function StatusModal({
  machine,
  onClose,
  onRefresh,
  onShowConfirmation,
  requestError,
  status,
  view
}: Omit<MachineConnectorActionsDialogsProps, 'isSubmitting' | 'onStart'> & {
  view?: Exclude<ConnectorDialogView, `confirm-${string}`>;
}) {
  const runtime = machine.connector.runtime;
  const update = machine.connector.update;
  const operation = update?.operation;
  const active = isRuntimeBusy(update);
  const failure = latestRuntimeFailure(update);
  const retryOperation = runtimeRetryOperation(machine);
  const canRetry = retryOperation === 'update'
    ? canUpdateMachineRuntime(machine)
    : retryOperation === 'restart'
      ? canRestartMachineRuntime(machine)
      : false;
  const newerThanApprovedRelease = update?.state === 'unsupported' &&
    runtime?.source === 'managed' &&
    status.capabilities.includes('runtime.update') &&
    Boolean(update.availableVersion);

  return (
    <Modal
      isOpen={Boolean(view)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Backdrop variant="blur" className="z-[80] bg-black/75">
        <Modal.Container
          placement="auto"
          scroll="inside"
          size="md"
          className="px-3 py-3 sm:px-5 sm:py-6"
        >
          <Modal.Dialog className="max-h-[min(42rem,calc(100dvh-1.5rem))] border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/60">
            <Modal.Header className="border-b border-neutral-900">
              <Modal.Heading>{view ? modalTitle(view, machine) : ''}</Modal.Heading>
              <Modal.CloseTrigger aria-label="Close connector dialog">
                <X className="size-4" />
              </Modal.CloseTrigger>
            </Modal.Header>
            <Modal.Body>
              {view === 'details' ? (
                <>
                  <div className="mb-3">
                    <p className="text-lg font-semibold text-neutral-100">
                      {runtimeVersionLabel(machine)}
                    </p>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {runtimeStateLabel(update?.state)}
                    </p>
                  </div>
                  <DetailRow label="Release" value={runtime?.releaseId ?? 'Unknown'} />
                  <DetailRow label="Build" value={runtime?.buildId ?? 'Unknown'} />
                  <DetailRow label="Protocol" value={runtime?.protocolVersion ?? 'Unknown'} />
                  <DetailRow
                    label="Platform"
                    value={runtime ? `${runtime.platform} · ${runtime.architecture}` : 'Unknown'}
                  />
                  <DetailRow
                    label="Channel"
                    value={runtime ? `${runtime.channel} · ${runtime.source}` : 'Unknown'}
                  />
                  <DetailRow label="Last checked" value={formatOptionalTime(runtime?.lastCheckedAt)} />
                  <DetailRow label="Connector" value={runtime?.bundleVersions.connector ?? 'Unknown'} />
                  <DetailRow
                    label="Machine tools"
                    value={runtime?.bundleVersions.machineTools ?? 'Unknown'}
                  />
                  <DetailRow label="Project CLI" value={runtime?.bundleVersions.projectCli ?? 'Unknown'} />
                  <DetailRow
                    label="Capabilities"
                    value={status.capabilities.length > 0 ? status.capabilities.join(', ') : 'None reported'}
                  />
                  {newerThanApprovedRelease ? (
                    <div className="mt-3 rounded-xl border border-sky-500/25 bg-sky-500/8 p-3">
                      <p className="text-sm font-medium text-sky-200">
                        Newer than the approved release
                      </p>
                      <p className="mt-1 text-xs leading-5 text-sky-200/70">
                        This machine is running {runtime?.version}. Project Space will not downgrade
                        it to {update?.availableVersion}; Restart remains available.
                      </p>
                    </div>
                  ) : update?.state === 'unsupported' ? (
                    <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/8 p-3">
                      <p className="text-sm font-medium text-amber-200">
                        Managed reinstall required
                      </p>
                      <p className="mt-1 text-xs leading-5 text-amber-200/70">
                        This connector cannot safely replace itself. Install the managed bundle,
                        preserving this machine&apos;s identity and settings, before using web updates.
                      </p>
                      <a
                        className="mt-2 inline-flex text-xs font-medium text-amber-100 underline decoration-amber-300/40 underline-offset-2"
                        href="/connector"
                      >
                        Open connector setup
                      </a>
                    </div>
                  ) : null}
                </>
              ) : view === 'progress' ? (
                <>
                  <div aria-live="polite" className="flex items-start gap-3">
                    <ProgressIcon machine={machine} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-neutral-100">
                        {runtimeOperationLabel(operation) || runtimeStateLabel(update?.state)}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-neutral-500">
                        {runtimeOperationOutcomeMessage(machine, operation)}
                      </p>
                    </div>
                  </div>
                  {active ? (
                    <ProgressBar
                      aria-label={runtimeOperationLabel(operation) || 'Connector operation in progress'}
                      color="accent"
                      isIndeterminate
                      size="sm"
                      className="mt-4"
                    >
                      <ProgressBar.Track>
                        <ProgressBar.Fill />
                      </ProgressBar.Track>
                    </ProgressBar>
                  ) : null}
                  {operation ? (
                    <div className="mt-4">
                      <DetailRow label="Operation" value={operation.operation} />
                      <DetailRow label="Updated" value={formatOptionalTime(operation.updatedAt)} />
                      <DetailRow
                        label="Release"
                        value={operation.expectedReleaseId ?? runtime?.releaseId ?? 'Unknown'}
                      />
                    </div>
                  ) : null}
                </>
              ) : view === 'failure' ? (
                failure ? (
                  <>
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-red-300" />
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-neutral-100">
                          {failure.message}
                        </p>
                        <p className="mt-1 break-all text-xs text-neutral-500">{failure.code}</p>
                      </div>
                    </div>
                    <div className="mt-4">
                      <DetailRow label="Failed" value={formatOptionalTime(failure.at)} />
                      <DetailRow
                        label="Recovery"
                        value={failure.rollbackAvailable
                          ? 'Rollback available'
                          : 'Manual recovery may be required'}
                      />
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-neutral-400">No failure details are available.</p>
                )
              ) : null}
              <RequestError message={requestError} />
            </Modal.Body>
            <Modal.Footer className="flex-col gap-2 min-[420px]:flex-row min-[420px]:justify-end">
              {view === 'failure' && retryOperation && canRetry ? (
                <Button
                  fullWidth
                  variant="primary"
                  onPress={() => onShowConfirmation(retryOperation)}
                  className="min-[420px]:w-auto"
                >
                  {retryOperation === 'update' ? (
                    <RefreshCw className="size-4" />
                  ) : (
                    <RotateCw className="size-4" />
                  )}
                  Retry {retryOperation}
                </Button>
              ) : null}
              {view === 'details' || view === 'progress' ? (
                <Button
                  fullWidth
                  variant="secondary"
                  onPress={onRefresh}
                  className="min-[420px]:w-auto"
                >
                  <RefreshCw className="size-3.5" />
                  {view === 'details' ? 'Refresh' : 'Check now'}
                </Button>
              ) : null}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

export function MachineConnectorActionsDialogs(props: MachineConnectorActionsDialogsProps) {
  const confirmation = props.view === 'confirm-update'
    ? 'update'
    : props.view === 'confirm-restart'
      ? 'restart'
      : undefined;
  const modalView = props.view && !props.view.startsWith('confirm-')
    ? props.view as Exclude<ConnectorDialogView, `confirm-${string}`>
    : undefined;

  return (
    <>
      <ConfirmationDialog {...props} operation={confirmation} />
      <StatusModal {...props} view={modalView} />
    </>
  );
}
