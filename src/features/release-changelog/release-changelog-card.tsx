import { Sparkles, X } from 'lucide-react';

import { Button } from '@heroui/react';
import type { ReleaseChangelogEntry } from '@/shared/release-changelog-api';

export function ReleaseChangelogCard({
  collapsed,
  onDismiss,
  onOpen,
  release
}: {
  collapsed: boolean;
  onDismiss(): void;
  onOpen(): void;
  release: ReleaseChangelogEntry;
}) {
  if (collapsed) {
    return (
      <div className="relative flex justify-center">
        <Button
          aria-label={`What's new in v${release.version}`}
          className="size-10 min-w-10 rounded-xl text-neutral-400 hover:bg-white/[.05] hover:text-neutral-100"
          isIconOnly
          onPress={onOpen}
          variant="ghost"
        >
          <Sparkles className="size-4" strokeWidth={1.8} />
        </Button>
        <span
          aria-hidden
          className="pointer-events-none absolute right-1.5 top-1.5 size-2 rounded-full bg-blue-400 ring-2 ring-[#151515]"
        />
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/[.08] bg-white/[.025] transition-[border-color,background-color,transform] hover:border-white/[.12] hover:bg-white/[.04] active:scale-[.99]">
      <button
        aria-label={`Open what's new in v${release.version}`}
        className="block w-full px-3.5 py-3 text-left"
        onClick={onOpen}
        type="button"
      >
        <span className="flex items-center gap-2 text-xs font-medium text-neutral-200">
          <Sparkles className="size-3.5 text-blue-300" strokeWidth={1.8} />
          What&apos;s new
          <span aria-hidden className="ml-auto size-2 rounded-full bg-blue-400" />
        </span>
        <span className="mt-1.5 block text-sm font-medium text-neutral-100">
          v{release.version}
        </span>
        <span className="mt-1 block text-[11px] text-neutral-500">Release notes</span>
      </button>
      <Button
        aria-label={`Dismiss what's new for v${release.version}`}
        className="absolute right-1.5 top-1.5 size-7 min-w-7 text-neutral-600 hover:bg-white/[.05] hover:text-neutral-300"
        isIconOnly
        onPress={onDismiss}
        size="sm"
        variant="ghost"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
