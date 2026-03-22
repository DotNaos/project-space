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
  onSelectProject(projectId: string): void;
}

export function SidebarProjectSelect({
  groupName,
  projects,
  selectedProjectId,
  onSelectProject
}: SidebarProjectSelectProps) {
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  if (projects.length < 2) {
    return null;
  }

  return (
    <div className="mt-3">
      <Text className="mb-2 px-1 text-[10px] uppercase tracking-[0.2em] text-slate-500">
        {groupName}
      </Text>

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
        <Select.Trigger className="min-h-9 rounded-xl border border-transparent bg-transparent px-2 text-left shadow-none transition hover:bg-slate-900/25">
          <Select.Value className="min-w-0 flex-1 text-sm font-medium text-slate-200/90">
            {({ isPlaceholder }) => (
              <span className="block truncate">
                {isPlaceholder ? 'Choose project' : (selectedProject?.name ?? 'Choose project')}
              </span>
            )}
          </Select.Value>
          <Select.Indicator className="text-slate-500/80" />
        </Select.Trigger>

        <Select.Popover className="min-w-[260px] rounded-2xl border border-slate-800/70 bg-slate-900/85">
          <ListBox aria-label={`${groupName} project options`} selectionMode="single">
            {projects.map((project) => (
              <ListBoxItem
                key={project.id}
                id={project.id}
                textValue={project.name}
                className="rounded-xl text-slate-200 data-[selected=true]:bg-slate-800/70"
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
