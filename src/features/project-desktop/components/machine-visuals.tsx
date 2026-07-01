import {
  Computer,
  Laptop,
  Link2,
  Monitor,
  Server,
  Unplug
} from 'lucide-react';
import { useId } from 'react';
import { cn } from '@/lib/utils';
import type { MachineRecord } from '@/shared/project-space-api';

type BatteryState = NonNullable<MachineRecord['battery']>['state'] | 'unavailable';

function normalizedMachineValues(machine: MachineRecord) {
  return [
    machine.kind,
    machine.name,
    machine.profile,
    machine.os?.family,
    ...machine.roles
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
}

export function machineOsFamily(machine: MachineRecord) {
  const values = normalizedMachineValues(machine);

  if (values.some((value) => value.includes('darwin') || value.includes('macos'))) {
    return 'macos';
  }

  if (values.some((value) => value.includes('ubuntu'))) {
    return 'ubuntu';
  }

  if (values.some((value) => value.includes('linux') || value.includes('unix'))) {
    return 'linux';
  }

  if (values.some((value) => value.includes('windows') || value.includes('win32'))) {
    return 'windows';
  }

  return 'unknown';
}

export function machineDeviceType(machine: MachineRecord) {
  const values = normalizedMachineValues(machine);

  if (values.some((value) => value.includes('server') || value.includes('vps'))) {
    return 'server';
  }

  if (
    values.some(
      (value) =>
        value.includes('laptop') ||
        value.includes('macbook') ||
        value.includes('yoga') ||
        value.includes('darwin')
    )
  ) {
    return 'laptop';
  }

  if (
    values.some(
      (value) =>
        value.includes('desktop') ||
        value.includes('workstation') ||
        value === 'pc' ||
        value.includes('imac')
    )
  ) {
    return 'pc';
  }

  return 'machine';
}

export function isMachineConnected(machine: MachineRecord) {
  return machine.connector.status === 'local' || machine.connector.status === 'online';
}

export function MachineConnectionIcon({
  className,
  machine
}: {
  className?: string;
  machine: MachineRecord;
}) {
  const isConnected = isMachineConnected(machine);

  if (isConnected) {
    return (
      <Link2
        aria-label="Connected"
        className={cn('size-4 text-emerald-400', className)}
        strokeWidth={1.9}
      />
    );
  }

  return (
    <Unplug
      aria-label="Disconnected"
      className={cn('size-4 text-neutral-600', className)}
      strokeWidth={1.9}
    />
  );
}

export function MachineDeviceIcon({
  className,
  machine
}: {
  className?: string;
  machine: MachineRecord;
}) {
  const deviceType = machineDeviceType(machine);
  const iconClassName = cn('size-4 text-neutral-400', className);

  if (deviceType === 'server') {
    return <Server aria-label="Server" className={iconClassName} strokeWidth={1.8} />;
  }

  if (deviceType === 'laptop') {
    return <Laptop aria-label="Laptop" className={iconClassName} strokeWidth={1.8} />;
  }

  if (deviceType === 'pc') {
    return <Monitor aria-label="PC" className={iconClassName} strokeWidth={1.8} />;
  }

  return <Computer aria-label="Machine" className={iconClassName} strokeWidth={1.8} />;
}

export function MachineOsMark({
  className,
  machine
}: {
  className?: string;
  machine: MachineRecord;
}) {
  const family = machineOsFamily(machine);

  if (family === 'macos') {
    return (
      <span
        aria-label="macOS"
        className={cn(
          'inline-flex size-4 shrink-0 items-center justify-center font-sans text-[13px] leading-none text-neutral-400',
          className
        )}
      >
        
      </span>
    );
  }

  if (family === 'ubuntu') {
    return (
      <svg
        aria-label="Ubuntu"
        role="img"
        viewBox="-142.5 -142.5 285 285"
        className={cn(
          'size-4 shrink-0',
          className
        )}
      >
        <circle fill="#dd4814" r="141.732" />
        <g fill="#fff">
          <g>
            <circle cx="-96.3772" r="18.9215" />
            <path d="M-45.6059,68.395C-62.1655,57.3316-74.4844,40.4175-79.6011,20.6065C-73.623,15.7354-69.8047,8.3164-69.8047,0C-69.8047,-8.3164-73.623,-15.7354-79.6011,-20.6065C-74.4844,-40.4175-62.1655,-57.3316-45.6059,-68.395L-31.7715,-45.2212C-45.9824,-35.2197-55.2754,-18.7026-55.2754,0C-55.2754,18.7026-45.9824,35.2197-31.7715,45.2212Z" />
          </g>
          <g transform="rotate(120)">
            <circle cx="-96.3772" r="18.9215" />
            <path d="M-45.6059,68.395C-62.1655,57.3316-74.4844,40.4175-79.6011,20.6065C-73.623,15.7354-69.8047,8.3164-69.8047,0C-69.8047,-8.3164-73.623,-15.7354-79.6011,-20.6065C-74.4844,-40.4175-62.1655,-57.3316-45.6059,-68.395L-31.7715,-45.2212C-45.9824,-35.2197-55.2754,-18.7026-55.2754,0C-55.2754,18.7026-45.9824,35.2197-31.7715,45.2212Z" />
          </g>
          <g transform="rotate(240)">
            <circle cx="-96.3772" r="18.9215" />
            <path d="M-45.6059,68.395C-62.1655,57.3316-74.4844,40.4175-79.6011,20.6065C-73.623,15.7354-69.8047,8.3164-69.8047,0C-69.8047,-8.3164-73.623,-15.7354-79.6011,-20.6065C-74.4844,-40.4175-62.1655,-57.3316-45.6059,-68.395L-31.7715,-45.2212C-45.9824,-35.2197-55.2754,-18.7026-55.2754,0C-55.2754,18.7026-45.9824,35.2197-31.7715,45.2212Z" />
          </g>
        </g>
      </svg>
    );
  }

  if (family === 'linux') {
    return (
      <span
        aria-label="Linux"
        className={cn(
          'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded bg-neutral-800 px-1 text-[8px] font-semibold leading-none text-neutral-300',
          className
        )}
      >
        Linux
      </span>
    );
  }

  if (family === 'windows') {
    return (
      <span
        aria-label="Windows"
        className={cn(
          'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded bg-sky-500/80 px-1 text-[8px] font-semibold leading-none text-white',
          className
        )}
      >
        Win
      </span>
    );
  }

  return (
    <span
      aria-label="Unknown OS"
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded bg-neutral-800 text-[9px] font-semibold leading-none text-neutral-500',
        className
      )}
    >
      OS
    </span>
  );
}

function batteryFillClass(percentage: number) {
  if (percentage <= 20) {
    return 'fill-red-400';
  }

  if (percentage <= 40) {
    return 'fill-amber-300';
  }

  return 'fill-neutral-100';
}

function batteryStateClass(state: BatteryState | undefined, percentage?: number) {
  if (state === 'unavailable') {
    return 'text-neutral-500';
  }

  if (state === 'charging') {
    return 'text-emerald-300';
  }

  if (percentage !== undefined && percentage <= 20) {
    return 'text-red-300';
  }

  if (percentage !== undefined && percentage <= 40) {
    return 'text-amber-300';
  }

  return 'text-neutral-100';
}

function batteryFillClassForState(state: BatteryState | undefined, percentage: number) {
  if (state === 'charging') {
    return 'fill-emerald-400';
  }

  return batteryFillClass(percentage);
}

function BatteryIconSvg({
  className,
  percentage,
  state
}: {
  className?: string;
  percentage?: number;
  state?: BatteryState;
}) {
  const clipId = useId();
  const cutoutId = useId();
  const bodyX = 1;
  const bodyWidth = 23.5;
  const fillWidth =
    percentage === undefined ? 0 : Math.max(1.8, bodyWidth * (percentage / 100));
  const hasBattery = percentage !== undefined && state !== 'unavailable';
  const isCharging = state === 'charging';
  const flashCutoutPath = 'M18.1 .9 7.4 9.6h5.95l-2.35 6.05 10.95-10h-6.3z';
  const flashPath = 'M17.7 1.8 8.35 9.35h5.5l-2 5.15 9.25-8.45h-5.55z';

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 30 16"
      className={cn('h-4 w-[1.875rem] shrink-0', className)}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={bodyX} y="2" width={bodyWidth} height="12" rx="4.2" />
        </clipPath>
        {isCharging ? (
          <mask id={cutoutId} maskUnits="userSpaceOnUse">
            <rect x="0" y="0" width="30" height="16" fill="white" />
            <path
              d={flashCutoutPath}
              fill="black"
              stroke="black"
              strokeLinejoin="round"
              strokeWidth="1.8"
            />
          </mask>
        ) : null}
      </defs>
      <rect
        x="23.15"
        y="5.25"
        width="4.6"
        height="5.5"
        rx="2.75"
        className={hasBattery ? 'fill-neutral-500' : 'fill-neutral-600'}
      />

      {!hasBattery ? (
        <>
          <rect
            x={bodyX}
            y="2"
            width={bodyWidth}
            height="12"
            rx="4.2"
            className="fill-neutral-500"
          />
          <rect
            x="3"
            y="4"
            width="19.4"
            height="8"
            rx="2.55"
            className="fill-app-panel"
          />
        </>
      ) : (
        <>
          <g mask={isCharging ? `url(#${cutoutId})` : undefined}>
            <rect
              x={bodyX}
              y="2"
              width={bodyWidth}
              height="12"
              rx="4.2"
              className="fill-neutral-500"
            />
            <rect
              x={bodyX}
              y="2"
              width={fillWidth}
              height="12"
              clipPath={`url(#${clipId})`}
              className={batteryFillClassForState(state, percentage)}
            />
          </g>
          {isCharging ? <path d={flashPath} className="fill-white" /> : null}
        </>
      )}
    </svg>
  );
}

function formatBatteryState(machine: MachineRecord) {
  if (!machine.battery) {
    return undefined;
  }

  return machine.battery.state && machine.battery.state !== 'unknown'
    ? machine.battery.state
    : undefined;
}

export function MachineBatteryMeter({
  compact,
  machine
}: {
  compact?: boolean;
  machine: MachineRecord;
}) {
  const battery = machine.battery;
  const percentage = battery
    ? Math.max(0, Math.min(100, Math.round(battery.percentage)))
    : undefined;
  const state = formatBatteryState(machine);
  const label = percentage === undefined ? 'Battery unavailable' : `Battery ${percentage}%`;
  const visualState: BatteryState = percentage === undefined ? 'unavailable' : state ?? 'unknown';

  return (
    <span
      aria-label={state ? `${label} ${state}` : label}
      data-battery-state={visualState}
      className={cn(
        'inline-flex items-center gap-1 text-neutral-400',
        compact ? 'text-[11px]' : 'gap-1.5 text-xs text-neutral-300'
      )}
    >
      {visualState !== 'unavailable' ? (
        <span className="relative inline-flex items-center" aria-hidden="true">
          <BatteryIconSvg
            percentage={percentage}
            state={visualState}
            className={batteryStateClass(visualState, percentage)}
          />
        </span>
      ) : null}
      <span className={cn('tabular-nums', percentage === undefined ? 'text-neutral-600' : '')}>
        {percentage === undefined ? '--' : `${percentage}%`}
      </span>
      {state && !compact ? <span className="text-neutral-500">{state}</span> : null}
    </span>
  );
}
