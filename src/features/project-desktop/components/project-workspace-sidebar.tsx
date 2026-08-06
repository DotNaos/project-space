import { useMemo, useState } from 'react';
import { Button, Modal, SearchField } from '@heroui/react';
import {
  ChevronDown,
  CircleDot,
  FileCheck2,
  FolderGit2,
  HelpCircle,
  MessageCircle,
  Monitor,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
  Settings
} from 'lucide-react';

import type { ProjectSpaceRecord } from '@/shared/project-space-api';
import type { ProjectDetailTab, ProjectMainView } from '../hooks/project-desktop-routing';
import type { RailAccount } from './app-rail';

interface WorkspaceNavItem {
  icon: typeof CircleDot;
  id: 'chat' | 'machines' | 'repository' | 'tasks' | 'templates';
  label: string;
}

const projectItems: WorkspaceNavItem[] = [
  { icon: MessageCircle, id: 'chat', label: 'Chat' },
  { icon: CircleDot, id: 'tasks', label: 'Tasks' },
  { icon: FolderGit2, id: 'repository', label: 'Repository' }
];

const globalItems: WorkspaceNavItem[] = [
  { icon: Monitor, id: 'machines', label: 'Machines' },
  { icon: FileCheck2, id: 'templates', label: 'Templates' }
];

function isVisibleProject(project: ProjectSpaceRecord) {
  const folder = project.rootPath.split('/').filter(Boolean).pop() ?? '';
  return !folder.startsWith('.') && !folder.endsWith('.worktrees');
}

function projectInitials(project: ProjectSpaceRecord) {
  const name = project.github?.name ?? project.name;
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function activeItem(mainView: ProjectMainView, tab: ProjectDetailTab) {
  if (mainView === 'settings' || mainView === 'machines' || mainView === 'machine') {
    return 'machines';
  }
  if (tab === 'chat' || tab === 'codex') return 'chat';
  if (tab === 'issues' || tab === 'roadmap') return 'tasks';
  if (tab === 'template') return 'templates';
  return 'repository';
}

function SidebarItem({
  active,
  collapsed,
  item,
  onPress
}: {
  active: boolean;
  collapsed: boolean;
  item: WorkspaceNavItem;
  onPress(): void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      aria-label={item.label}
      title={collapsed ? item.label : undefined}
      onClick={onPress}
      className={`group flex h-10 w-full items-center rounded-xl text-sm transition-[background-color,color,scale] active:scale-[.97] ${
        collapsed ? 'justify-center px-0' : 'gap-3 px-3 text-left'
      } ${
        active
          ? 'bg-white/[.08] font-medium text-neutral-50'
          : 'text-neutral-500 hover:bg-white/[.04] hover:text-neutral-200'
      }`}
    >
      <Icon className="size-4 shrink-0" strokeWidth={active ? 2 : 1.75} />
      {collapsed ? null : <span className="min-w-0 flex-1 truncate">{item.label}</span>}
    </button>
  );
}

function ProjectSelector({
  collapsed,
  currentProject,
  onSelect,
  projects
}: {
  collapsed: boolean;
  currentProject: ProjectSpaceRecord;
  onSelect(projectId: string): void;
  projects: ProjectSpaceRecord[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return projects
      .filter(isVisibleProject)
      .filter((project) => {
        const name = project.github?.name ?? project.name;
        const owner = project.github?.owner ?? 'Local';
        return `${owner}/${name}`.toLowerCase().includes(normalizedQuery);
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [projects, query]);

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`Switch project, current project ${currentProject.name}`}
        onClick={() => setIsOpen(true)}
        title={collapsed ? currentProject.name : undefined}
        className={`flex h-10 w-full items-center rounded-xl transition-colors hover:bg-white/[.04] ${
          collapsed ? 'justify-center' : 'gap-2 px-2 text-left'
        }`}
      >
        {collapsed ? (
          <span className="text-[11px] font-semibold tracking-tight text-neutral-300">
            {projectInitials(currentProject)}
          </span>
        ) : (
          <>
            <ChevronDown className="size-3.5 text-neutral-600" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-200">
              {currentProject.github?.name ?? currentProject.name}
            </span>
          </>
        )}
      </button>

      <Modal
        isOpen={isOpen}
        onOpenChange={(open) => {
          setIsOpen(open);
          if (!open) setQuery('');
        }}
      >
        <Modal.Backdrop className="bg-black/70" variant="blur">
          <Modal.Container className="p-3 sm:p-6" placement="center" scroll="inside" size="sm">
            <Modal.Dialog className="flex max-h-[min(38rem,calc(100dvh-1.5rem))] min-h-0 flex-col overflow-hidden bg-neutral-950 text-neutral-100 ring-1 ring-inset ring-white/10">
              <Modal.CloseTrigger aria-label="Close project switcher" />
              <Modal.Header className="shrink-0 px-5 pb-2 pt-5">
                <Modal.Heading className="text-base font-semibold">Switch project</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="min-h-0 overflow-y-auto px-4 pb-2 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="space-y-0.5">
                  {visibleProjects.map((project) => {
                    const name = project.github?.name ?? project.name;
                    const owner = project.github?.owner ?? 'Local';
                    return (
                      <button
                        type="button"
                        key={project.id}
                        onClick={() => {
                          onSelect(project.id);
                          setIsOpen(false);
                        }}
                        className="flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-white/[.06]"
                      >
                        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/[.07] text-[10px] font-semibold text-neutral-300">
                          {projectInitials(project)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium leading-4">{name}</span>
                          <span className="block truncate text-[10px] leading-4 text-neutral-500">{owner}</span>
                        </span>
                        {project.id === currentProject.id ? (
                          <span className="text-[10px] text-neutral-500">Current</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </Modal.Body>
              <Modal.Footer className="relative shrink-0 px-4 pb-4 pt-3">
                <div aria-hidden className="absolute inset-x-4 top-0 h-px bg-white/[.07]" />
                <SearchField aria-label="Search projects" fullWidth onChange={setQuery} value={query} variant="secondary">
                  <SearchField.Group className="h-10 border-neutral-800 bg-neutral-900">
                    <SearchField.SearchIcon className="size-4 text-neutral-400" />
                    <SearchField.Input placeholder="Search projects" />
                    <SearchField.ClearButton />
                  </SearchField.Group>
                </SearchField>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}

export function ProjectWorkspaceSidebar({
  account,
  collapsed,
  currentProject,
  mainView,
  onClose,
  onCollapsedChange,
  onNewTask,
  onOpenMachines,
  onOpenSettings,
  onSelectProject,
  onSelectTab,
  projectTab,
  projects
}: {
  account?: RailAccount;
  collapsed: boolean;
  currentProject: ProjectSpaceRecord;
  mainView: ProjectMainView;
  onClose(): void;
  onCollapsedChange(collapsed: boolean): void;
  onNewTask(): void;
  onOpenMachines(): void;
  onOpenSettings(): void;
  onSelectProject(projectId: string): void;
  onSelectTab(tab: ProjectDetailTab): void;
  projectTab: ProjectDetailTab;
  projects: ProjectSpaceRecord[];
}) {
  const selectedItem = activeItem(mainView, projectTab);
  const openItem = (id: WorkspaceNavItem['id']) => {
    if (id === 'machines') onOpenMachines();
    else if (id === 'templates') onSelectTab('template');
    else if (id === 'chat') onSelectTab('chat');
    else if (id === 'tasks') onSelectTab('issues');
    else onSelectTab('workspaces');
    onClose();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#151515] text-neutral-100">
      <div className={`flex h-14 shrink-0 items-center ${collapsed ? 'justify-center px-2' : 'justify-end px-4'}`}>
        <Button isIconOnly aria-label="Close sidebar" className="sm:hidden" size="sm" variant="ghost" onPress={onClose}>
          <PanelLeft className="size-4" />
        </Button>
        <Button
          isIconOnly
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden text-neutral-600 hover:text-neutral-300 sm:inline-flex"
          size="sm"
          variant="ghost"
          onPress={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </Button>
      </div>

      <nav className={`min-h-0 flex-1 overflow-y-auto pb-4 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${collapsed ? 'px-2' : 'px-4'}`}>
        <ProjectSelector collapsed={collapsed} currentProject={currentProject} onSelect={onSelectProject} projects={projects} />
        <button
          type="button"
          aria-label="New task"
          title={collapsed ? 'New task' : undefined}
          onClick={onNewTask}
          className={`mt-1 flex h-10 w-full items-center rounded-xl text-sm text-neutral-300 transition-[background-color,color,scale] hover:bg-white/[.04] hover:text-white active:scale-[.97] ${collapsed ? 'justify-center' : 'gap-3 px-3'}`}
        >
          <PencilLine className="size-4" strokeWidth={1.8} />
          {collapsed ? null : <span>New task</span>}
        </button>

        <div className={collapsed ? 'mt-2' : 'mt-5'}>
          {collapsed ? null : <p className="px-3 pb-2 text-[11px] font-medium text-neutral-600">Project</p>}
          {projectItems.map((item) => (
            <SidebarItem key={item.id} item={item} collapsed={collapsed} active={selectedItem === item.id} onPress={() => openItem(item.id)} />
          ))}
        </div>

        <div className={collapsed ? 'mt-3 border-t border-white/[.06] pt-3' : 'mt-6'}>
          {collapsed ? null : <p className="px-3 pb-2 text-[11px] font-medium text-neutral-600">Global</p>}
          {globalItems.map((item) => (
            <SidebarItem key={item.id} item={item} collapsed={collapsed} active={selectedItem === item.id} onPress={() => openItem(item.id)} />
          ))}
        </div>
      </nav>

      <div className={`${collapsed ? 'mx-2' : 'mx-4'} mb-3 shrink-0`}>
        <div className={`flex h-9 items-center ${collapsed ? 'justify-center' : 'gap-2 px-1'}`}>
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[.05] text-[10px] font-semibold text-neutral-500">
            {(account?.name ?? account?.email ?? 'OS').trim().slice(0, 2).toUpperCase()}
          </span>
          {collapsed ? null : (
            <>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-400">{account?.name ?? 'Oli'}</span>
              <Button isIconOnly aria-label="Help" className="size-7 min-w-7 text-neutral-700 hover:text-neutral-400" size="sm" variant="ghost">
                <HelpCircle className="size-3.5" />
              </Button>
              <Button isIconOnly aria-label="Settings" className="size-7 min-w-7 text-neutral-700 hover:text-neutral-400" size="sm" variant="ghost" onPress={onOpenSettings}>
                <Settings className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
