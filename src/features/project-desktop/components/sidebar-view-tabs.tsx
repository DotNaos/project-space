import { Surface, Switch, Text } from '@heroui/react';

export type SidebarView = 'workspace' | 'files';

interface SidebarViewTabsProps {
  value: SidebarView;
  onChange(value: SidebarView): void;
}

export function SidebarViewTabs({
  value,
  onChange
}: SidebarViewTabsProps) {
  const isFiles = value === 'files';

  return (
    <Surface
      variant="secondary"
      className="flex items-center justify-between rounded-2xl border border-zinc-800/60 bg-zinc-950/18 px-4 py-3"
    >
      <Text
        className={
          isFiles ? 'text-sm font-medium text-zinc-500' : 'text-sm font-medium text-zinc-100'
        }
      >
        Workspace
      </Text>

      <Switch
        aria-label="Toggle inline file tree"
        isSelected={isFiles}
        onChange={(nextValue) => {
          onChange(nextValue ? 'files' : 'workspace');
        }}
      />

      <Text
        className={
          isFiles ? 'text-sm font-medium text-zinc-100' : 'text-sm font-medium text-zinc-500'
        }
      >
        Files
      </Text>
    </Surface>
  );
}
