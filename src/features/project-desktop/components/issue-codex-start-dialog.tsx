import {
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import {
  Button,
  Label,
  Link,
  Modal,
  Radio,
  RadioGroup,
  Tooltip
} from '@heroui/react';
import {
  Container,
  ExternalLink,
  Laptop,
  LoaderCircle,
  Play,
  Power,
  Server,
  TriangleAlert
} from 'lucide-react';
import type {
  IssueMachineEnvironmentKind,
  IssueMachineProjectRow
} from './issue-development-machine-actions';
import type {
  IssueCodexConnectorTarget,
  IssueCodexStartPresentation
} from './issue-codex-work-list-model';
import { GitHubMark } from './github-mark';
import {
  MachineOsFamilyMark,
  MachineOsMark
} from './machine-visuals';
import type {
  IssueCodexHostWakeState,
  IssueCodexOfflineHostGroup
} from './use-issue-codex-host-wake';

export interface IssueCodexStartDialogGroup {
  key: string;
  name: string;
  targets: Array<{
    presentation: IssueCodexStartPresentation;
    target: IssueCodexConnectorTarget;
  }>;
}

export type IssueCodexOfflineDialogGroup = IssueCodexOfflineHostGroup;

interface IssueCodexStartDialogProps {
  busyConnectorId?: string;
  cloudDestination?: ReactNode;
  groups: IssueCodexStartDialogGroup[];
  isOpen: boolean;
  offlineGroups: IssueCodexOfflineDialogGroup[];
  hostWakeStates: Record<string, IssueCodexHostWakeState>;
  onOpenChange(isOpen: boolean): void;
  onStart(row: IssueMachineProjectRow): void;
  onWake(group: IssueCodexOfflineDialogGroup): void;
  cloudFooterAction?: IssueCodexDialogFooterAction;
}

const codespaceDestinationValue = 'github-codespace';

export interface IssueCodexDialogFooterAction {
  isDisabled: boolean;
  isPending: boolean;
  label?: string;
  onPress(): void;
}

export function submitIssueCodexStart(
  start: () => void,
  onOpenChange: (isOpen: boolean) => void
) {
  start();
  onOpenChange(false);
}

function DestinationIcon({
  kind,
  target
}: {
  kind?: IssueMachineEnvironmentKind;
  target: IssueCodexConnectorTarget;
}) {
  if (target.row.machine) {
    return <MachineOsMark className="size-4" machine={target.row.machine} />;
  }

  switch (kind) {
    case 'macos':
    case 'native_macos':
      return <MachineOsFamilyMark className="size-4" family="macos" />;
    case 'windows':
    case 'native_windows':
      return <MachineOsFamilyMark className="size-4" family="windows" />;
    case 'linux':
    case 'native_linux':
    case 'wsl':
      return <MachineOsFamilyMark className="size-4" family="linux" />;
    case 'docker':
      return <Container aria-hidden className="size-4 shrink-0 text-neutral-400" />;
    case 'virtual_machine':
    case 'kubernetes_workload':
      return <Server aria-hidden className="size-4 shrink-0 text-neutral-400" />;
    case 'github_codespace':
    case 'cloud_sandbox':
      return <GitHubMark className="size-4 shrink-0 text-neutral-300" />;
    default:
      return <Laptop aria-hidden className="size-4 shrink-0 text-neutral-400" />;
  }
}

function DestinationRadioControl() {
  return (
    <Radio.Control className="size-5 shrink-0 !rounded-full">
      <Radio.Indicator className="!rounded-full">
        {({ isSelected }) => (
          <span className={`size-2 rounded-full bg-white transition-transform ${
            isSelected ? 'scale-100' : 'scale-0'
          }`} />
        )}
      </Radio.Indicator>
    </Radio.Control>
  );
}

function DestinationWarning({
  destination,
  message
}: {
  destination: string;
  message: string;
}) {
  return (
    <Tooltip delay={150}>
      <Tooltip.Trigger
        aria-label={`${destination} availability details`}
        className="inline-flex size-7 shrink-0 cursor-help items-center justify-center rounded-full text-amber-300 outline-none transition hover:bg-amber-400/10 focus-visible:ring-2 focus-visible:ring-amber-300/60"
        tabIndex={0}
      >
        <TriangleAlert aria-hidden className="size-3.5" />
      </Tooltip.Trigger>
      <Tooltip.Content
        className="max-w-64 whitespace-normal text-left text-xs leading-5"
        placement="top end"
        showArrow
      >
        <Tooltip.Arrow />
        {message}
      </Tooltip.Content>
    </Tooltip>
  );
}

export function IssueCodexStartDialog({
  busyConnectorId,
  cloudDestination,
  cloudFooterAction,
  groups,
  hostWakeStates,
  isOpen,
  offlineGroups,
  onOpenChange,
  onStart,
  onWake
}: IssueCodexStartDialogProps) {
  const isBusy = Boolean(busyConnectorId);
  const [selectedValue, setSelectedValue] = useState('');
  const hasCloudDestination = Boolean(cloudDestination);
  const onlineGroupKeys = useMemo(() => new Set(groups.map((group) => group.key)), [groups]);
  const visibleOfflineGroups = useMemo(
    () => offlineGroups.filter((group) => !onlineGroupKeys.has(group.key)),
    [offlineGroups, onlineGroupKeys]
  );
  const machineDestinations = useMemo(() => [
    ...groups.flatMap((group) => {
      const choice = group.targets.find(({ presentation }) => presentation.canStart)
        ?? group.targets[0];
      return choice ? [{
        group,
        groupName: group.name,
        kind: 'online' as const,
        presentation: choice.presentation,
        target: choice.target,
        value: `host:${group.key}`
      }] : [];
    }),
    ...visibleOfflineGroups.flatMap((group) => {
      const target = group.targets[0];
      return target ? [{
        group,
        groupName: group.name,
        kind: 'offline' as const,
        presentation: undefined,
        target,
        value: `host:${group.key}`
      }] : [];
    })
  ], [groups, visibleOfflineGroups]);
  const firstDestinationValue = machineDestinations.find((destination) => (
    destination.kind === 'online'
      ? destination.presentation.canStart
      : hostWakeStates[destination.group.key]?.phase === 'wakeable'
  ))?.value
    ?? (hasCloudDestination ? codespaceDestinationValue : '');
  const selectedMachine = machineDestinations.find(
    (destination) => destination.value === selectedValue
  );
  const dialogPending = isBusy || Boolean(cloudFooterAction?.isPending);
  const selectedHostWake = selectedMachine?.kind === 'offline'
    ? hostWakeStates[selectedMachine.group.key]
    : undefined;
  const canStartSelectedMachine = selectedMachine?.kind === 'online'
    ? selectedMachine.presentation.canStart
    : selectedHostWake?.phase === 'wakeable';

  useEffect(() => {
    if (!isOpen) {
      setSelectedValue('');
      return;
    }
    setSelectedValue((current) => {
      const currentExists = current === codespaceDestinationValue
        ? hasCloudDestination
        : machineDestinations.some((destination) => destination.value === current);
      return currentExists ? current : firstDestinationValue;
    });
  }, [firstDestinationValue, hasCloudDestination, isOpen, machineDestinations]);

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
    >
      <Modal.Backdrop
        className="z-[140] bg-black/75"
        isDismissable
        variant="blur"
      >
        <Modal.Container className="p-4" placement="center" scroll="inside" size="sm">
          <Modal.Dialog className="bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/70 sm:max-w-[420px]">
            <Modal.CloseTrigger aria-label="Close new task dialog" />
            <Modal.Header className="items-start !gap-0 !pb-5 !pt-2 text-left">
              <Modal.Heading className="text-lg font-semibold tracking-tight">
                Start development
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="grid min-w-0 gap-2 !overflow-x-hidden !mt-1">
              <RadioGroup
                className="min-w-0 w-full gap-2"
                isDisabled={dialogPending}
                name="development-destination"
                onChange={setSelectedValue}
                value={selectedValue}
                variant="secondary"
              >
                <Label>Destination</Label>
                <div className="divide-y divide-white/[.06] overflow-hidden rounded-2xl bg-white/[.04]">
                  {machineDestinations.map((destination) => {
                    const {
                      group,
                      groupName,
                      kind,
                      presentation,
                      target,
                      value
                    } = destination;
                    const wakeState = kind === 'offline' ? hostWakeStates[group.key] : undefined;
                    const isWakeable = wakeState?.phase === 'wakeable';
                    const message = kind === 'online'
                      ? presentation.message
                      : wakeState?.message ?? `${groupName} is offline.`;
                    return (
                    <Radio
                      className="!mt-0 min-w-0 w-full"
                      isDisabled={kind === 'offline' && !isWakeable}
                      key={value}
                      value={value}
                    >
                      <Radio.Content className="relative min-h-12 min-w-0 w-full !flex-row items-center gap-3 bg-transparent px-3 py-2 transition data-[focus-visible=true]:bg-white/[.04]">
                        <DestinationRadioControl />
                        <DestinationIcon kind={target.environmentKind} target={target} />
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-neutral-100">
                            {groupName}
                          </span>
                        </div>
                        {isWakeable ? (
                          <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-blue-300">
                            <Power aria-hidden className="size-3" />
                            Remote start
                          </span>
                        ) : null}
                        {kind === 'offline' && wakeState?.phase === 'checking' ? (
                          <LoaderCircle aria-label={`Checking ${groupName}`} className="size-3.5 animate-spin text-neutral-500" />
                        ) : null}
                        {(kind === 'online' && !presentation.canStart) ||
                         (kind === 'offline' && !isWakeable && wakeState?.phase !== 'checking') ? (
                          <DestinationWarning
                            destination={groupName}
                            message={message}
                          />
                        ) : null}
                      </Radio.Content>
                    </Radio>
                    );
                  })}

                  {cloudDestination ? (
                    <div className="relative">
                      <Radio className="!mt-0 min-w-0 w-full" value={codespaceDestinationValue}>
                        <Radio.Content className="relative min-h-12 min-w-0 w-full !flex-row items-center gap-3 bg-transparent py-2 pl-3 pr-12 transition data-[focus-visible=true]:bg-blue-500/10">
                          <DestinationRadioControl />
                          <GitHubMark className="size-4 shrink-0 text-neutral-300" />
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-neutral-100">
                              GitHub Codespaces
                            </span>
                          </div>
                        </Radio.Content>
                      </Radio>
                      <Link
                        aria-label="Open GitHub Codespaces"
                        className="absolute right-2 top-6 z-10 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-neutral-400 no-underline transition hover:bg-white/[.06] hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-blue-400/60"
                        href="https://github.com/codespaces"
                        rel="noreferrer"
                        target="_blank"
                      >
                        <ExternalLink aria-hidden className="size-3.5" />
                      </Link>
                      {selectedValue === codespaceDestinationValue ? (
                        <div className="issue-rise-in min-w-0 border-t border-white/[.07] pb-3 pt-2">
                          {cloudDestination}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </RadioGroup>
            </Modal.Body>
            <Modal.Footer className="!mt-3 !flex-col gap-2">
              <Button
                className="h-10 w-full !rounded-full whitespace-nowrap"
                isDisabled={selectedValue === codespaceDestinationValue
                  ? !cloudFooterAction || cloudFooterAction.isDisabled
                  : !canStartSelectedMachine || dialogPending}
                onPress={() => {
                  if (selectedValue === codespaceDestinationValue) {
                    if (cloudFooterAction) {
                      submitIssueCodexStart(cloudFooterAction.onPress, onOpenChange);
                    }
                  } else if (selectedMachine?.kind === 'online' &&
                             selectedMachine.presentation.canStart) {
                    submitIssueCodexStart(
                      () => onStart(selectedMachine.target.row),
                      onOpenChange
                    );
                  } else if (selectedMachine?.kind === 'offline' &&
                             selectedHostWake?.phase === 'wakeable') {
                    submitIssueCodexStart(
                      () => onWake(selectedMachine.group),
                      onOpenChange
                    );
                  }
                }}
                size="sm"
                variant="primary"
              >
                {dialogPending
                  ? <LoaderCircle className="size-4 animate-spin" />
                  : <Play className="size-4" />}
                {cloudFooterAction?.label
                  ?? (dialogPending
                    ? 'Starting…'
                    : selectedValue ? 'Start development' : 'Select a destination')}
              </Button>
              <Button
                className="h-10 w-full !rounded-full !bg-transparent !text-neutral-400 hover:!text-neutral-100 whitespace-nowrap"
                onPress={() => onOpenChange(false)}
                size="sm"
                variant="ghost"
              >
                Close
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
