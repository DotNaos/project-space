import { BookOpen, Info, ScrollText } from 'lucide-react';

import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownPopover,
  DropdownTrigger,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';

export function InformationMenu({
  currentVersion,
  hasUnreadRelease = false,
  onOpenDocumentation,
  onOpenPreviewChangelog,
  onOpenReleaseChangelog,
  placement = 'top right',
  triggerClassName
}: {
  currentVersion?: string;
  hasUnreadRelease?: boolean;
  onOpenDocumentation(): void;
  onOpenPreviewChangelog?(): void;
  onOpenReleaseChangelog(): void;
  placement?: string;
  triggerClassName?: string;
}) {
  const popoverStyle = placement.startsWith('right')
    ? {
        bottom: 0,
        left: '100%',
        marginBottom: 0,
        marginLeft: 8,
        marginTop: 0,
        right: 'auto',
        top: 'auto'
      }
    : placement.includes('left')
      ? { left: 0, right: 'auto' }
      : undefined;

  return (
    <Dropdown>
      <DropdownTrigger
        aria-label="Information"
        className={cn(
          'relative size-8 min-w-8 rounded-xl border-0 bg-transparent px-0 text-neutral-600 hover:bg-white/[.05] hover:text-neutral-300',
          triggerClassName
        )}
      >
        <Info className="size-4" strokeWidth={1.8} />
        {hasUnreadRelease ? (
          <span
            aria-hidden
            className="absolute right-1 top-1 size-2 rounded-full bg-blue-400 ring-2 ring-[#151515]"
          />
        ) : null}
      </DropdownTrigger>
      <DropdownPopover
        offset={8}
        placement={placement}
        className="w-56 rounded-xl border-white/[.08] bg-neutral-950 p-1.5"
        style={{ minWidth: '14rem', width: '14rem', ...popoverStyle }}
      >
        <DropdownMenu aria-label="Information" className="space-y-0.5">
          <DropdownItem
            className="rounded-lg px-2.5 py-2.5"
            onPress={onOpenReleaseChangelog}
            textValue="Changelog"
          >
            <div className="flex items-center gap-2.5">
              <ScrollText className="size-4 shrink-0 text-neutral-500" />
              <span className="min-w-0 flex-1">
                <Text className="block text-sm text-current">Changelog</Text>
                {currentVersion ? (
                  <Text className="block text-[11px] text-neutral-600">
                    Project Space v{currentVersion}
                  </Text>
                ) : null}
              </span>
              {hasUnreadRelease ? (
                <span aria-hidden className="size-2 rounded-full bg-blue-400" />
              ) : null}
            </div>
          </DropdownItem>
          {onOpenPreviewChangelog ? (
            <DropdownItem
              className="rounded-lg px-2.5 py-2.5"
              onPress={onOpenPreviewChangelog}
              textValue="Preview changelog"
            >
              <div className="flex items-center gap-2.5">
                <ScrollText className="size-4 shrink-0 text-neutral-500" />
                <Text className="text-sm text-current">Preview changelog</Text>
              </div>
            </DropdownItem>
          ) : null}
          <DropdownItem
            className="rounded-lg px-2.5 py-2.5"
            onPress={onOpenDocumentation}
            textValue="Documentation"
          >
            <div className="flex items-center gap-2.5">
              <BookOpen className="size-4 shrink-0 text-neutral-500" />
              <Text className="text-sm text-current">Documentation</Text>
            </div>
          </DropdownItem>
        </DropdownMenu>
      </DropdownPopover>
    </Dropdown>
  );
}
