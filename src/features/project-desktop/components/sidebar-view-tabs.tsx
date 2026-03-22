import { cn } from '@/lib/utils';

export type SidebarView = 'workspace' | 'files';

interface SidebarViewTabsProps {
  value: SidebarView;
  onChange(value: SidebarView): void;
}

const items: Array<{ value: SidebarView; label: string }> = [
  { value: 'workspace', label: 'Workspace' },
  { value: 'files', label: 'Files' }
];

export function SidebarViewTabs({
  value,
  onChange
}: SidebarViewTabsProps) {
  return (
    <div className="border-b border-slate-800 px-3 py-2">
      <div className="flex items-center gap-1 rounded-[10px] bg-slate-900/50 p-1">
        {items.map((item) => {
          const active = item.value === value;

          return (
            <button
              key={item.value}
              type="button"
              onClick={() => onChange(item.value)}
              className={cn(
                'flex-1 rounded-[8px] px-3 py-1.5 text-xs font-medium transition',
                active
                  ? 'bg-slate-700 text-slate-50'
                  : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-200'
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
