import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { LauncherAppRecord } from '@/shared/electron-api';

interface OpenTargetDropdownProps {
  apps: LauncherAppRecord[];
  disabled?: boolean;
  onOpen(): void;
  onSelectApp(appId: string): void;
  selectedApp?: LauncherAppRecord;
  selectedAppLabel?: string;
}

const appIconSizeClass = 'h-8 w-8';
const triggerIconSizeClass = 'h-9 w-9';

function AppIcon({
  app,
  className
}: {
  app?: LauncherAppRecord;
  className?: string;
}) {
  const iconSource = app?.iconDataUrl ?? app?.iconUrl;

  if (iconSource) {
    return (
      <img
        src={iconSource}
        alt=""
        className={cn(`${appIconSizeClass} shrink-0 rounded-lg object-contain`, className)}
      />
    );
  }

  return (
    <span
      className={cn(
        `flex ${appIconSizeClass} shrink-0 items-center justify-center rounded-lg bg-slate-800 text-xs font-semibold text-slate-300`,
        className
      )}
    >
      {app?.label.slice(0, 1).toUpperCase() ?? '?'}
    </span>
  );
}

function TriggerAppIcon({ app }: { app?: LauncherAppRecord }) {
  const iconSource = app?.iconDataUrl ?? app?.iconUrl;

  if (iconSource) {
    return (
      <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg">
        <img
          src={iconSource}
          alt=""
          className="h-full w-full shrink-0 scale-125 object-cover"
        />
      </span>
    );
  }

  return <AppIcon app={app} className={triggerIconSizeClass} />;
}

export function OpenTargetDropdown({
  apps,
  disabled = false,
  onOpen,
  onSelectApp,
  selectedApp,
  selectedAppLabel
}: OpenTargetDropdownProps) {
  return (
    <div className="flex items-center rounded-2xl border border-slate-700/80 bg-slate-900/70 p-0.5 shadow-sm shadow-black/10">
      <Button
        type="button"
        variant="ghost"
        disabled={disabled || (!selectedApp && !selectedAppLabel)}
        onClick={onOpen}
        className="h-11 w-11 min-w-0 rounded-xl px-0 text-slate-100 hover:bg-slate-800"
      >
        <TriggerAppIcon
          app={
            selectedApp ?? (selectedAppLabel ? { appName: '', id: '', label: selectedAppLabel } : undefined)
          }
        />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled || apps.length === 0}
            className="flex h-11 w-8 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:text-slate-700"
          >
            <ChevronDown className="h-4 w-4" strokeWidth={1.9} />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="min-w-60">
          {apps.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-500">Loading apps...</div>
          ) : null}
          {apps.map((app) => {
            const active = selectedApp?.id === app.id;

            return (
              <DropdownMenuItem
                key={app.id}
                onSelect={() => onSelectApp(app.id)}
                className={cn(
                  'gap-3 text-slate-300 data-[highlighted]:bg-slate-800/90 data-[highlighted]:text-slate-50',
                  active && 'bg-slate-800 text-slate-50'
                )}
              >
                <AppIcon app={app} />
                <span>{app.label}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
