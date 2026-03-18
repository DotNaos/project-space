import { cn } from '@/lib/utils';

interface SpaceItem {
  id: string;
  label: string;
}

interface SpacesDockProps {
  projects: SpaceItem[];
  activeProjectId: string;
  onSelect(projectId: string): void;
  onCreate(): void;
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
  projects,
  activeProjectId,
  onSelect,
  onCreate
}: SpacesDockProps) {
  return (
    <div className="border-t border-slate-800 px-4 py-4">
      <div className="flex items-center justify-center gap-2">
        <div className="flex items-center gap-0.5">
          {projects.map((project) => {
            const active = activeProjectId === project.id;

            return (
              <button
                key={project.id}
                type="button"
                aria-label={project.label}
                title={project.label}
                onClick={() => onSelect(project.id)}
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
                  {shortLabel(project.label)}
                </span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onCreate}
          aria-label="Add project space"
          className="flex h-6 w-6 items-center justify-center rounded-[9px] text-sm leading-none text-slate-500 transition hover:bg-slate-800/70 hover:text-slate-100"
        >
          +
        </button>
      </div>
    </div>
  );
}
