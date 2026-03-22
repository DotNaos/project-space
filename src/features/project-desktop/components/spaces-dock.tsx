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
          <button
            type="button"
            onClick={onNavigateUp}
            aria-label="Back to project root"
            className="flex h-6 w-6 items-center justify-center rounded-[9px] text-sm leading-none text-slate-500 transition hover:bg-slate-800/70 hover:text-slate-100"
          >
            ←
          </button>
        ) : null}

        <div className="flex items-center gap-0.5">
          {items.map((item) => {
            const active = activeItemId === item.id;

            return (
              <button
                key={item.id}
                type="button"
                aria-label={item.label}
                title={item.label}
                onClick={() => onSelect(item.id)}
                className={cn(
                  'group flex h-6 w-6 items-center justify-center rounded-[9px] transition',
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
              </button>
            );
          })}
        </div>

        {onCreate ? (
          <button
            type="button"
            onClick={onCreate}
            aria-label="Add project space"
            className="flex h-6 w-6 items-center justify-center rounded-[9px] text-sm leading-none text-slate-500 transition hover:bg-slate-800/70 hover:text-slate-100"
          >
            +
          </button>
        ) : null}
      </div>
    </div>
  );
}
