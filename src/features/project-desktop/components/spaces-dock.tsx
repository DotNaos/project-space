import { useState } from 'react';

import { Button } from '@heroui/react';
import { cn } from '@/lib/utils';

interface SpaceItem {
  id: string;
  label: string;
}

const initialSpaces: SpaceItem[] = [
  { id: 'space-focus', label: 'Focus' },
  { id: 'space-work', label: 'Work' },
  { id: 'space-review', label: 'Review' }
];

export function SpacesDock() {
  const [spaces, setSpaces] = useState(initialSpaces);
  const [activeSpaceId, setActiveSpaceId] = useState(initialSpaces[1]?.id ?? initialSpaces[0].id);

  function addSpace() {
    const nextIndex = spaces.length + 1;
    const nextSpace = {
      id: `space-${nextIndex}`,
      label: `Space ${nextIndex}`
    };

    setSpaces((current) => [...current, nextSpace]);
    setActiveSpaceId(nextSpace.id);
  }

  return (
    <div className="border-t border-slate-800 px-4 py-4">
      <div className="flex items-center justify-center gap-2">
        <div className="flex items-center gap-0.5">
          {spaces.map((space) => {
            const active = activeSpaceId === space.id;

            return (
              <Button
                key={space.id}
                type="button"
                aria-label={space.label}
                isIconOnly
                variant={active ? 'secondary' : 'ghost'}
                size="sm"
                onPress={() => setActiveSpaceId(space.id)}
                className={cn(
                  'group flex h-6 w-6 min-w-0 items-center justify-center rounded-[9px] border border-transparent p-0 transition',
                  active
                    ? 'bg-slate-800/90 text-slate-100 shadow-[0_0_0_1px_rgba(148,163,184,0.12)]'
                    : 'text-slate-400 hover:border-slate-700/80 hover:bg-slate-800/70 hover:text-slate-100'
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full transition',
                    active
                      ? 'bg-slate-100 shadow-[0_0_0_3px_rgba(241,245,249,0.08)]'
                      : 'bg-slate-600 group-hover:bg-slate-400'
                  )}
                />
              </Button>
            );
          })}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onPress={addSpace}
          aria-label="Add space"
          className="flex h-6 w-6 min-w-0 items-center justify-center rounded-[9px] border border-transparent p-0 text-slate-500 transition hover:bg-slate-800/70 hover:text-slate-100"
        >
          <span className="text-sm leading-none">+</span>
        </Button>
      </div>
    </div>
  );
}
