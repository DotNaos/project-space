import { useMemo, useState } from 'react';
import { Button, Modal, SearchField } from '@heroui/react';
import {
  ChevronDown,
  CircleDot,
  FileCheck2,
  FolderKanban,
  FolderGit2,
  GitBranch,
  LayoutDashboard,
  MessageCircle,
  Monitor,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PencilLine,
  Rocket,
  Settings,
  Workflow
} from 'lucide-react';

import type { AppMeta, ProjectSpaceRecord } from '@/shared/project-space-api';
import type { ReleaseChangelogEntry } from '@/shared/release-changelog-api';
import { ReleaseChangelogCard } from '@/features/release-changelog/release-changelog-card';
import type {
  ProjectDetailTab,
  ProjectMainView,
  SettingsSection
} from '../hooks/project-desktop-routing';
import { AccountMenu, type RailAccount } from './account-menu';
import { InformationMenu } from './information-menu';
import { LocalSimulationIndicator } from './local-simulation-indicator';
import { RuntimeAccessLink } from './runtime-access-link';

interface WorkspaceNavItem {
  icon: typeof CircleDot;
  id:
    | 'chat'
    | 'deployments'
    | 'history'
    | 'machines'
    | 'overview'
    | 'projects'
    | 'roadmap'
    | 'tasks'
    | 'templates'
    | 'workspaces';
  label: string;
}

const projectItems: WorkspaceNavItem[] = [
  { icon: MessageCircle, id: 'chat', label: 'Chat' },
  { icon: CircleDot, id: 'tasks', label: 'Tasks' },
  { icon: Workflow, id: 'roadmap', label: 'Roadmap' },
  { icon: LayoutDashboard, id: 'overview', label: 'Overview' },
  { icon: FolderGit2, id: 'workspaces', label: 'Workspaces' },
  { icon: GitBranch, id: 'history', label: 'Git history' },
  { icon: Rocket, id: 'deployments', label: 'Deployments' },
  { icon: FileCheck2, id: 'templates', label: 'Templates' }
];

const globalItems: WorkspaceNavItem[] = [
  { icon: FolderKanban, id: 'projects', label: 'Projects' },
  { icon: Monitor, id: 'machines', label: 'Hosts' }
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

export function workspaceSidebarActiveItem(
  mainView: ProjectMainView,
  tab: ProjectDetailTab,
  settingsSection: SettingsSection
): WorkspaceNavItem['id'] | 'settings' {
  if (mainView === 'chat' || mainView === 'codex') return 'chat';
  if (mainView === 'root' || mainView === 'topology' || mainView === 'projects') {
    return 'projects';
  }
  if (mainView === 'settings' || mainView === 'machines' || mainView === 'machine') {
    return settingsSection === 'machines' ? 'machines' : 'settings';
  }

  const itemByTab: Record<ProjectDetailTab, WorkspaceNavItem['id']> = {
    chat: 'chat',
    codex: 'chat',
    deployments: 'deployments',
    history: 'history',
    issues: 'tasks',
    machines: 'machines',
    overview: 'overview',
    roadmap: 'roadmap',
    template: 'templates',
    workspaces: 'workspaces'
  };

  return itemByTab[tab];
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
      data-testid={`sidebar-${item.id}`}
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
  projects,
  runtime
}: {
  collapsed: boolean;
  currentProject?: ProjectSpaceRecord;
  onSelect(projectId: string): void;
  projects: ProjectSpaceRecord[];
  runtime?: AppMeta['runtime'];
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
      <div>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={currentProject
            ? `Switch project, current project ${currentProject.name}`
            : 'Select project'}
          onClick={() => setIsOpen(true)}
          title={collapsed ? (currentProject?.name ?? 'Projects') : undefined}
          className={`flex h-10 w-full items-center rounded-xl transition-colors hover:bg-white/[.04] ${
            collapsed ? 'justify-center' : 'gap-2 px-2 text-left'
          }`}
        >
          {collapsed ? (
            <span className="text-[11px] font-semibold tracking-tight text-neutral-300">
              {currentProject ? projectInitials(currentProject) : 'PS'}
            </span>
          ) : (
            <>
              <ChevronDown className="size-3.5 text-neutral-600" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-200">
                {currentProject?.github?.name ?? currentProject?.name ?? 'Select project'}
              </span>
            </>
          )}
        </button>
        {runtime?.apis === 'simulated' ? (
          <div className={collapsed ? '-mt-0.5 flex justify-center pb-1' : '-mt-0.5 px-7 pb-1'}>
            <LocalSimulationIndicator compact={collapsed} runtime={runtime} />
          </div>
        ) : null}
      </div>

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
                        {project.id === currentProject?.id ? (
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
  onOpenChat,
  onDismissRelease,
  onOpenDocumentation,
  onNewTask,
  onOpenMachines,
  onOpenPreviewChangelog,
  onOpenProjects,
  onOpenReleaseChangelog,
  onOpenSettings,
  onSelectProject,
  onSelectTab,
  projectTab,
  projects,
  release,
  releaseCardVisible,
  releaseVersion,
  runtime,
  settingsSection
}: {
  account?: RailAccount;
  collapsed: boolean;
  currentProject?: ProjectSpaceRecord;
  mainView: ProjectMainView;
  onClose(): void;
  onCollapsedChange(collapsed: boolean): void;
  onOpenChat(): void;
  onDismissRelease(): void;
  onOpenDocumentation(): void;
  onNewTask(): void;
  onOpenMachines(): void;
  onOpenPreviewChangelog?(): void;
  onOpenProjects(): void;
  onOpenReleaseChangelog(): void;
  onOpenSettings(): void;
  onSelectProject(projectId: string): void;
  onSelectTab(tab: ProjectDetailTab): void;
  projectTab: ProjectDetailTab;
  projects: ProjectSpaceRecord[];
  release?: ReleaseChangelogEntry;
  releaseCardVisible: boolean;
  releaseVersion?: string;
  runtime?: AppMeta['runtime'];
  settingsSection: SettingsSection;
}) {
  const selectedItem = workspaceSidebarActiveItem(mainView, projectTab, settingsSection);
  const openItem = (id: WorkspaceNavItem['id']) => {
    if (id === 'projects') onOpenProjects();
    else if (id === 'machines') onOpenMachines();
    else if (id === 'chat' && !currentProject) onOpenChat();
    else {
      const tabByItem: Partial<Record<WorkspaceNavItem['id'], ProjectDetailTab>> = {
        chat: 'chat',
        deployments: 'deployments',
        history: 'history',
        overview: 'overview',
        roadmap: 'roadmap',
        tasks: 'issues',
        templates: 'template',
        workspaces: 'workspaces'
      };
      const tab = tabByItem[id];
      if (tab) onSelectTab(tab);
    }
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
        <ProjectSelector collapsed={collapsed} currentProject={currentProject} onSelect={onSelectProject} projects={projects} runtime={runtime} />
        {currentProject ? (
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
        ) : null}

        {!currentProject ? (
          <div className={collapsed ? 'mt-2' : 'mt-5'}>
            {collapsed ? null : (
              <p className="px-3 pb-2 text-[11px] font-medium text-neutral-600">Workspace</p>
            )}
            <SidebarItem
              active={selectedItem === 'chat'}
              collapsed={collapsed}
              item={projectItems[0]}
              onPress={() => openItem('chat')}
            />
          </div>
        ) : null}

        {currentProject ? (
          <div className={collapsed ? 'mt-2' : 'mt-5'}>
            {collapsed ? null : <p className="px-3 pb-2 text-[11px] font-medium text-neutral-600">Project</p>}
            {projectItems.map((item) => (
              <SidebarItem key={item.id} item={item} collapsed={collapsed} active={selectedItem === item.id} onPress={() => openItem(item.id)} />
            ))}
          </div>
        ) : null}

        <div className={collapsed ? 'mt-3 border-t border-white/[.06] pt-3' : 'mt-6'}>
          {collapsed ? null : <p className="px-3 pb-2 text-[11px] font-medium text-neutral-600">Global</p>}
          {globalItems.map((item) => (
            <SidebarItem key={item.id} item={item} collapsed={collapsed} active={selectedItem === item.id} onPress={() => openItem(item.id)} />
          ))}
        </div>
      </nav>

      {releaseCardVisible && release ? (
        <div className={`${collapsed ? 'mx-2' : 'mx-4'} mb-2 shrink-0`}>
          <ReleaseChangelogCard
            collapsed={collapsed}
            onDismiss={onDismissRelease}
            onOpen={onOpenReleaseChangelog}
            release={release}
          />
        </div>
      ) : null}

      <div className={`${collapsed ? 'mx-2' : 'mx-4'} mb-3 shrink-0 border-t border-white/[.06] pt-3`}>
        <RuntimeAccessLink collapsed={collapsed} runtime={runtime} />
        <div className={`flex items-center ${collapsed ? 'flex-col gap-1' : 'gap-1 px-1'}`}>
          {account ? <AccountMenu account={account} placement="top start" /> : null}
          {collapsed ? null : (
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-400">
              {account?.name ?? account?.email ?? 'Project Space'}
            </span>
          )}
          <InformationMenu
            currentVersion={releaseVersion}
            hasUnreadRelease={releaseCardVisible}
            onOpenDocumentation={onOpenDocumentation}
            onOpenPreviewChangelog={onOpenPreviewChangelog}
            onOpenReleaseChangelog={onOpenReleaseChangelog}
            placement="top right"
          />
          <Button isIconOnly aria-label="Settings" data-testid="sidebar-settings" className="size-8 min-w-8 text-neutral-600 hover:text-neutral-300" size="sm" variant="ghost" onPress={onOpenSettings}>
            <Settings className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
