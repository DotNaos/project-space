import type { ReactNode } from 'react';
import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { MachineRecord } from '@/shared/project-space-api';
import {
  MachineBatteryMeter,
  MachineConnectionIcon,
  MachineDeviceIcon,
  MachineOsMark
} from './machine-visuals';
import { machineSubtitle } from './project-main-model';
import { ConnectorChannelChip } from './connector-channel-chip';
import { MachineResourceSummary } from './machine-resource-usage';

interface MachineListItemProps {
  className?: string;
  compact?: boolean;
  endContent?: ReactNode;
  fallbackName?: string;
  isSelected?: boolean;
  machine?: MachineRecord;
  name?: string;
  onPress?(): void;
  showConnection?: boolean;
  subtitle?: string;
}

export function MachineListItem({
  className,
  compact = false,
  endContent,
  fallbackName = 'Machine',
  isSelected = false,
  machine,
  name: nameOverride,
  onPress,
  showConnection = true,
  subtitle
}: MachineListItemProps) {
  const name = nameOverride ?? machine?.name ?? fallbackName;
  const resolvedSubtitle = subtitle ?? (machine ? machineSubtitle(machine) : '');
  const content = (
    <>
      {showConnection && machine ? <MachineConnectionIcon machine={machine} /> : null}
      {machine ? (
        <MachineDeviceIcon machine={machine} />
      ) : (
        <span className="size-4 shrink-0 rounded border border-neutral-700" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <Text
            className={cn(
              'block truncate font-semibold text-neutral-100',
              compact ? 'text-sm' : 'text-base'
            )}
          >
            {name}
          </Text>
          {machine ? <MachineOsMark machine={machine} /> : null}
          <ConnectorChannelChip machine={machine} />
        </span>
        {resolvedSubtitle ? (
          <Text className="block truncate text-xs text-neutral-500">
            {resolvedSubtitle}
          </Text>
        ) : null}
        {machine ? <MachineResourceSummary className="mt-0.5" resources={machine.resources} /> : null}
      </span>
      {machine ? <MachineBatteryMeter compact machine={machine} /> : null}
      {endContent}
    </>
  );
  const itemClassName = cn(
    'flex w-full min-w-0 items-center gap-3 rounded-lg text-left transition',
    compact ? 'px-2.5 py-2' : 'px-3 py-3',
    isSelected ? 'bg-neutral-800/90 text-neutral-50' : 'text-neutral-300 hover:bg-neutral-900/60',
    className
  );

  if (onPress) {
    return (
      <button
        type="button"
        onClick={onPress}
        aria-current={isSelected ? 'true' : undefined}
        className={itemClassName}
      >
        {content}
      </button>
    );
  }

  return <div className={itemClassName}>{content}</div>;
}
