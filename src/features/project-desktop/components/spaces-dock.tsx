import { Button, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { cn } from '@/lib/utils';

interface SpaceItem {
  id: string;
  kind: 'group' | 'project';
  label: string;
}

interface SpacesDockProps {
  items: SpaceItem[];
  activeItemId: string;
  canNavigateUp?: boolean;
  onNavigateUp?(): void;
  onSelect(itemId: string): void;
  onCreate?(): void;
}

function shortLabel(label: string) {
  return label
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 1)
    .toUpperCase();
}

export function SpacesDock({
  items,
  activeItemId,
  canNavigateUp = false,
  onNavigateUp,
  onSelect,
  onCreate
}: SpacesDockProps) {
  return (
    <div className="border-t border-slate-800 px-4 py-4">
      <div className="flex items-center justify-center gap-2">
        {canNavigateUp && onNavigateUp ? (
          <Button
            aria-label="Back to project root"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={onNavigateUp}
            className="h-7 w-7 min-w-0 rounded-[10px] px-0 text-sm leading-none text-slate-500 transition hover:bg-slate-800/70 hover:text-slate-100"
          >
            ←
          </Button>
        ) : null}

        <ToggleButtonGroup
          disallowEmptySelection
          isDetached
        selectedKeys={new Set(activeItemId ? [activeItemId] : [])}
        selectionMode="single"
        size="sm"
        onSelectionChange={(keys) => {
          const [nextItemId] = keys;

          if (typeof nextItemId === 'string') {
            onSelect(nextItemId);
          }
          }}
          className="rounded-[10px] bg-transparent"
        >
          {items.map((item) => {
            const active = activeItemId === item.id;

            return (
              <ToggleButton
                key={item.id}
                id={item.id}
                aria-label={item.label}
                isIconOnly
                variant="ghost"
                className={cn(
                  'group h-7 w-7 min-w-0 rounded-[10px] px-0 transition',
                  active ? 'bg-slate-800/90' : 'hover:bg-slate-800/70'
                )}
              >
                <span
                  className={cn(
                    'text-[10px] font-semibold tracking-[0.12em] transition',
                    active
                      ? 'text-slate-100'
                      : 'text-slate-500 group-hover:text-slate-300'
                  )}
                >
                  {shortLabel(item.label)}
                </span>
              </ToggleButton>
            );
          })}
        </ToggleButtonGroup>

        {onCreate ? (
          <Button
            aria-label="Add project space"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={onCreate}
            className="h-7 w-7 min-w-0 rounded-[10px] px-0 text-sm leading-none text-slate-500 transition hover:bg-slate-800/70 hover:text-slate-100"
          >
            +
          </Button>
        ) : null}
      </div>
    </div>
  );
}
