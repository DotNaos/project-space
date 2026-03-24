import { Tab, TabIndicator, TabList, TabSeparator, Tabs } from '@heroui/react';

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
    <div className="border-b border-zinc-800 px-3 py-2">
      <Tabs
        selectedKey={value}
        variant="primary"
        onSelectionChange={(key) => {
          if (key === 'workspace' || key === 'files') {
            onChange(key);
          }
        }}
        className="w-full"
      >
        <TabList className="grid w-full grid-cols-2">
          {items.map((item) => (
            <Tab
              key={item.value}
              id={item.value}
              className="flex-1 text-xs"
            >
              <TabSeparator />
              {item.label}
              <TabIndicator />
            </Tab>
          ))}
        </TabList>
      </Tabs>
    </div>
  );
}
