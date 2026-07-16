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
import { machineOsFamily } from './machine-platform-model';

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

export { machineOsFamily } from './machine-platform-model';

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
      <svg
        aria-label="macOS"
        role="img"
        viewBox="0 0 24 24"
        className={cn(
          'size-4 shrink-0 fill-neutral-300',
          className
        )}
      >
        <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
      </svg>
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
      <svg
        aria-label="Linux"
        role="img"
        viewBox="0 0 24 24"
        className={cn(
          'size-4 shrink-0 fill-neutral-300',
          className
        )}
      >
        <ellipse cx="12" cy="13" rx="7" ry="9" fill="#202124" />
        <ellipse cx="12" cy="14" rx="4.4" ry="6.2" fill="#f5f5f4" />
        <ellipse cx="9.7" cy="7.5" rx="2.2" ry="2.7" fill="#f5f5f4" />
        <ellipse cx="14.3" cy="7.5" rx="2.2" ry="2.7" fill="#f5f5f4" />
        <circle cx="10.2" cy="7.8" r=".8" fill="#202124" />
        <circle cx="13.8" cy="7.8" r=".8" fill="#202124" />
        <path d="m12 9 2 1.4-2 1.2-2-1.2L12 9Z" fill="#f59e0b" />
        <path d="M7.2 20.1 11 20.7 8.3 23H5.8l1.4-2.9Zm9.6 0L13 20.7l2.7 2.3h2.5l-1.4-2.9Z" fill="#f59e0b" />
      </svg>
    );
  }

  if (family === 'windows') {
    return (
      <svg
        aria-label="Windows"
        role="img"
        viewBox="0 0 24 24"
        className={cn(
          'size-4 shrink-0 fill-sky-400',
          className
        )}
      >
        <path d="M2 3.4 10.4 2v9.2H2V3.4Zm9.6-1.6L22 0v11.2H11.6V1.8ZM2 12.8h8.4V22L2 20.6v-7.8Zm9.6 0H22V24l-10.4-1.8v-9.4Z" />
      </svg>
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
