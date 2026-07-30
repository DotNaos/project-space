'use client';

import {
  SidebarItem,
  useSidebar,
} from 'fumadocs-ui/components/sidebar/base';
import type * as PageTree from 'fumadocs-core/page-tree';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import {
  getActiveReleaseAnchor,
  setActiveReleaseAnchor,
  subscribeActiveReleaseAnchor,
} from '@/lib/releases/active-anchor';

export function ReleaseSidebarItem({
  item,
}: {
  item: PageTree.Item;
}) {
  const pathname = usePathname();
  const { setOpen } = useSidebar();
  const activeAnchor = useSyncExternalStore(
    subscribeActiveReleaseAnchor,
    getActiveReleaseAnchor,
    () => undefined,
  );
  const [itemPath, hash] = item.url.split('#');
  const active = hash
    ? pathname === itemPath && activeAnchor === hash
    : pathname === itemPath;

  return (
    <SidebarItem
      active={active}
      href={item.url}
      icon={item.icon}
      onClick={() => {
        if (hash) setActiveReleaseAnchor(hash);
        setOpen(false);
      }}
    >
      {item.name}
    </SidebarItem>
  );
}
