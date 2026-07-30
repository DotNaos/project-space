'use client';

import type * as PageTree from 'fumadocs-core/page-tree';
import {
  SidebarFolder,
  SidebarFolderContent,
  SidebarFolderTrigger,
  SidebarItem,
  useFolder,
  useFolderDepth,
} from 'fumadocs-ui/components/sidebar/base';
import { usePathname } from 'next/navigation';

const interactiveClass =
  'relative flex items-center gap-2 rounded-lg p-2 text-start text-fd-muted-foreground wrap-anywhere [&_svg]:size-4 [&_svg]:shrink-0 transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80 hover:transition-none';
const activeLinkClass =
  "data-[active=true]:bg-fd-primary/10 data-[active=true]:text-fd-primary data-[active=true]:before:content-[''] data-[active=true]:before:absolute data-[active=true]:before:inset-y-2.5 data-[active=true]:before:inset-s-2.5 data-[active=true]:before:w-px data-[active=true]:before:bg-fd-primary";

export function ReleaseSidebarFolder({
  children,
  item,
}: {
  children: React.ReactNode;
  item: PageTree.Folder;
}) {
  const pathname = usePathname();
  const active = folderContainsPath(item, pathname);

  return (
    <SidebarFolder
      active={active}
      collapsible={item.collapsible}
      defaultOpen={item.defaultOpen}
    >
      {item.index ? (
        <IndexedFolderHeader index={item.index} item={item} />
      ) : (
        <FolderTrigger item={item} />
      )}
      <FolderContent>{children}</FolderContent>
    </SidebarFolder>
  );
}

function IndexedFolderHeader({
  index,
  item,
}: {
  index: PageTree.Item;
  item: PageTree.Folder;
}) {
  const folder = useFolder();
  const pathname = usePathname();
  const active = pathname === index.url;
  const padding = folderPadding(folder?.depth ?? 1);

  return (
    <div className="flex items-center gap-0.5">
      <SidebarItem
        active={active}
        aria-current={active ? 'page' : undefined}
        className={`${interactiveClass} ${activeLinkClass} min-w-0 flex-1`}
        external={index.external}
        href={index.url}
        style={{ paddingInlineStart: padding }}
      >
        {item.icon}
        {item.name}
      </SidebarItem>
      <SidebarFolderTrigger
        aria-label={`Toggle ${item.name} releases`}
        className={`${interactiveClass} shrink-0`}
      >
        <span className="sr-only">
          Toggle {item.name} releases
        </span>
      </SidebarFolderTrigger>
    </div>
  );
}

function FolderTrigger({ item }: { item: PageTree.Folder }) {
  const folder = useFolder();
  return (
    <SidebarFolderTrigger
      className={`${interactiveClass} w-full`}
      style={{
        paddingInlineStart: folderPadding(folder?.depth ?? 1),
      }}
    >
      {item.icon}
      {item.name}
    </SidebarFolderTrigger>
  );
}

function FolderContent({ children }: { children: React.ReactNode }) {
  const depth = useFolderDepth();
  return (
    <SidebarFolderContent
      className={
        depth === 1
          ? "relative before:absolute before:inset-y-1 before:inset-s-2.5 before:w-px before:bg-fd-border before:content-['']"
          : 'relative'
      }
    >
      <div className="flex flex-col gap-0.5 pt-0.5">
        {children}
      </div>
    </SidebarFolderContent>
  );
}

function folderContainsPath(
  folder: PageTree.Folder,
  pathname: string,
): boolean {
  if (folder.index?.url === pathname) return true;
  return folder.children.some((child) => {
    if (child.type === 'page') {
      return child.url.split('#')[0] === pathname;
    }
    return child.type === 'folder'
      ? folderContainsPath(child, pathname)
      : false;
  });
}

function folderPadding(depth: number) {
  return `calc(${2 + 3 * (depth - 1)} * var(--spacing))`;
}
