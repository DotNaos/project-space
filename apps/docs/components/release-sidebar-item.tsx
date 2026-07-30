'use client';

import {
  SidebarItem,
  useFolderDepth,
  useSidebar,
} from 'fumadocs-ui/components/sidebar/base';
import type * as PageTree from 'fumadocs-core/page-tree';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const releaseAnchorEvent = 'project-space:release-anchor';

export function ReleaseSidebarItem({
  item,
}: {
  item: PageTree.Item;
}) {
  const pathname = usePathname();
  const { setOpen } = useSidebar();
  const depth = useFolderDepth();
  const [activeAnchor, setActiveAnchor] = useState<string>();
  const [itemPath, hash] = item.url.split('#');
  const patchItem = /^release-\d+\.\d+\.\d+$/.test(
    item.$id ?? '',
  );
  const active = hash && patchItem
    ? pathname === itemPath && activeAnchor === hash
    : !hash && pathname === itemPath;

  useEffect(() => {
    const sync = (event?: Event) => {
      const eventAnchor =
        event instanceof CustomEvent &&
        typeof event.detail === 'string'
          ? event.detail
          : undefined;
      setActiveAnchor(
        eventAnchor ??
          document.documentElement.dataset.releaseActiveAnchor ??
          window.location.hash.slice(1) ??
          undefined,
      );
    };
    sync();
    window.addEventListener(releaseAnchorEvent, sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener(releaseAnchorEvent, sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  return (
    <SidebarItem
      active={active}
      aria-current={active ? 'location' : undefined}
      className={`${sidebarItemClass} ${
        depth >= 1 ? nestedItemClass : ''
      } ${
        active
          ? 'border-s-2 border-fd-primary bg-fd-primary/10 font-semibold text-fd-primary'
          : ''
      }`}
      external={item.external}
      href={item.url}
      icon={item.icon}
      onClick={() => {
        if (hash) publishActiveAnchor(hash);
        setOpen(false);
      }}
      style={{
        paddingInlineStart: `calc(${2 + 3 * depth} * var(--spacing))`,
      }}
    >
      {item.name}
    </SidebarItem>
  );
}

const sidebarItemClass =
  'relative flex items-center gap-2 rounded-lg p-2 text-start text-fd-muted-foreground wrap-anywhere [&_svg]:size-4 [&_svg]:shrink-0 transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80 hover:transition-none';
const nestedItemClass =
  "data-[active=true]:before:absolute data-[active=true]:before:inset-y-2.5 data-[active=true]:before:inset-s-2.5 data-[active=true]:before:w-px data-[active=true]:before:bg-fd-primary data-[active=true]:before:content-['']";

function publishActiveAnchor(anchor: string) {
  document.documentElement.dataset.releaseActiveAnchor = anchor;
  window.dispatchEvent(
    new CustomEvent(releaseAnchorEvent, { detail: anchor }),
  );
}
