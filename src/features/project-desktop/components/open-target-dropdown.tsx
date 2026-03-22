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
}

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
        className={cn('h-4 w-4 shrink-0 rounded-[4px]', className)}
      />
    );
  }

  return (
    <span
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-slate-800 text-[10px] font-semibold text-slate-300',
        className
      )}
    >
      {app?.label.slice(0, 1).toUpperCase() ?? '?'}
    </span>
  );
}

export function OpenTargetDropdown({
  apps,
  disabled = false,
  onOpen,
  onSelectApp,
  selectedApp
}: OpenTargetDropdownProps) {
  return (
    <div className="flex items-center rounded-xl border border-slate-700 bg-slate-900/80 p-1 shadow-sm shadow-black/10">
      <Button
        type="button"
        variant="ghost"
        disabled={disabled || !selectedApp}
        onClick={onOpen}
        className="h-9 gap-2 rounded-[10px] px-3 text-slate-100 hover:bg-slate-800"
      >
        <AppIcon app={selectedApp} />
        <span>{selectedApp?.label ?? 'Choose app'}</span>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled || apps.length === 0}
            className="flex h-9 w-9 items-center justify-center rounded-[10px] text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:text-slate-700"
          >
            <ChevronDown className="h-4 w-4" strokeWidth={1.9} />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="min-w-60">
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
