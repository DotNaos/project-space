import {
  Label,
  ListBox,
  ListBoxItem,
  Select,
  Text,
  Tooltip
} from '@heroui/react';
import type { ProjectSpaceRecord } from '@/shared/electron-api';

interface SidebarProjectSelectProps {
  groupName: string;
  projects: ProjectSpaceRecord[];
  selectedProjectId: string;
  variant?: 'default' | 'header';
  onSelectProject(projectId: string): void;
}

export function SidebarProjectSelect({
  groupName,
  projects,
  selectedProjectId,
  variant = 'default',
  onSelectProject
}: SidebarProjectSelectProps) {
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  if (projects.length < 2) {
    return null;
  }

  const isHeaderVariant = variant === 'header';

  return (
    <div className={isHeaderVariant ? 'min-w-0 flex-1' : 'mt-3'}>
      {isHeaderVariant ? null : (
        <Text className="mb-2 px-1 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          {groupName}
        </Text>
      )}

      <Select
        aria-label={`${groupName} projects`}
        className="w-full"
        placeholder="Choose project"
        value={selectedProjectId || null}
        variant="secondary"
        onChange={(value) => {
          if (typeof value === 'string') {
            onSelectProject(value);
          }
        }}
      >
        <Select.Trigger
          className={
            isHeaderVariant
              ? 'group relative flex h-10 min-h-10 items-center rounded-none border-none bg-transparent px-0 py-0 pl-7 text-left shadow-none transition hover:bg-transparent'
              : 'min-h-9 rounded-xl border border-transparent bg-transparent px-2 text-left shadow-none transition hover:bg-zinc-900/25'
          }
        >
          <Select.Value
            className={
              isHeaderVariant
                ? 'min-w-0 flex-1 text-[24px] font-semibold leading-none tracking-tight text-zinc-100'
                : 'min-w-0 flex-1 text-sm font-medium text-zinc-200/90'
            }
          >
            {({ isPlaceholder }) => (
              <span
                className={
                  isHeaderVariant
                    ? 'relative inline-block max-w-full truncate after:absolute after:right-0 after:bottom-0 after:left-0 after:h-0.5 after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-200 group-hover:after:scale-x-100'
                    : 'block truncate'
                }
              >
                {isPlaceholder ? 'Choose project' : (selectedProject?.name ?? 'Choose project')}
              </span>
            )}
          </Select.Value>
          <Select.Indicator
            className={
              isHeaderVariant
                ? 'absolute top-1/2 left-0 w-5 -translate-y-1/2 text-zinc-500'
                : 'text-zinc-500/80'
            }
          />
        </Select.Trigger>

        <Select.Popover className="min-w-[260px] rounded-2xl border border-zinc-800/70 bg-zinc-900/85">
          <ListBox aria-label={`${groupName} project options`} selectionMode="single">
            {projects.map((project) => (
              <ListBoxItem
                key={project.id}
                id={project.id}
                textValue={project.name}
                className="rounded-xl text-zinc-200 data-[selected=true]:bg-zinc-800/70"
              >
                <Tooltip delay={0}>
                  <Tooltip.Trigger className="block w-full">
                    <Label>{project.name}</Label>
                  </Tooltip.Trigger>
                  <Tooltip.Content showArrow placement="right">
                    <Tooltip.Arrow />
                    {project.rootPath}
                  </Tooltip.Content>
                </Tooltip>
              </ListBoxItem>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </div>
  );
}
