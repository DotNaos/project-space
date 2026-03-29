import type {
  ExplorerTarget,
  LauncherAppRecord,
  ProjectIssueSourceConfig,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import { Button, Card, Surface, Text } from '@heroui/react';

import type { EditableIdeaValues, IdeaPresentationRecord } from '../lib/idea-utils';
import { OpenTargetDropdown } from './open-target-dropdown';
import { ProjectCommandCenter } from './project-command-center';
import { ProjectIdeasPanel } from './project-ideas-panel';
import { ProjectIssueSourceLinkButton } from './project-issue-source-link-button';
import { ProjectSettingsPanel, type SettingsTab } from './project-settings-panel';
import { ProjectWorktreesPanel } from './project-worktrees-panel';
import { SidebarProjectSelect } from './sidebar-project-select';

export type ProjectMainView = 'ideas' | 'settings' | 'workspace' | 'worktrees';

interface ProjectMainPanelProps {
  activeSettingsTab: SettingsTab;
  assignedIdeaIds: string[];
  discoveryRoot: string;
  draftValues: EditableIdeaValues;
  groupedProjects: ProjectSpaceRecord[];
  groupedProjectsLabel?: string;
  ideas: IdeaPresentationRecord[];
  isDirty: boolean;
  isIdeasLoading: boolean;
  isIssueSourceLoading: boolean;
  isIssueSourceSaving: boolean;
  isSavingIdea: boolean;
  isSidebarOpen: boolean;
  launcherApps: LauncherAppRecord[];
  launcherError: string;
  loadIdeasError: string;
  mainView: ProjectMainView;
  onCreateIdea(): void;
  onCreateProject(): void;
  onMoveIdeaToWorktree(ideaId: string, targetWorktreeId?: string): void;
  onOpenIssueSource(): void;
  onOpenSelectedTarget(): void;
  onSaveIdea(): void;
  onSaveIssueSourceConfig(): void;
  onSelectProject(projectId: string): void;
  onSelectSettingsTab(tab: SettingsTab): void;
  onSelectIdea(ideaId: string): void;
  onSelectLauncherApp(appId: string): void;
  onUpdateIdeaValue<Key extends keyof EditableIdeaValues>(
    key: Key,
    value: EditableIdeaValues[Key]
  ): void;
  onUpdateIssueSourceKind(kind: ProjectIssueSourceConfig['kind']): void;
  onUpdateIssueSourceUrl(url: string): void;
  onToggleShowClosedIdeas(nextValue: boolean): void;
  issueSourceConfig: ProjectIssueSourceConfig;
  issueSourceDraftKind: ProjectIssueSourceConfig['kind'];
  issueSourceDraftUrl: string;
  issueSourceError: string;
  project?: ProjectSpaceRecord;
  selectedApp?: LauncherAppRecord;
  selectedAppLabel?: string;
  selectedExplorerTarget: ExplorerTarget;
  selectedIdea?: IdeaPresentationRecord;
  selectedTargetPath: string;
  selectedTargetIdeas: IdeaPresentationRecord[];
  selectedWorktree?: ProjectWorktreeRecord;
  showClosedIdeas: boolean;
  sidebarClosedPaddingLeft: number;
  syncErrors: Record<string, string>;
  worktrees: ProjectWorktreeRecord[];
}

export function ProjectMainPanel({
  activeSettingsTab,
  assignedIdeaIds,
  discoveryRoot,
  draftValues,
  groupedProjects,
  groupedProjectsLabel,
  isDirty,
  isIssueSourceLoading,
  isIssueSourceSaving,
  isSavingIdea,
  isSidebarOpen,
  launcherApps,
  launcherError,
  loadIdeasError,
  mainView,
  onCreateIdea,
  onCreateProject,
  onMoveIdeaToWorktree,
  onOpenIssueSource,
  onOpenSelectedTarget,
  onSaveIdea,
  onSaveIssueSourceConfig,
  onSelectProject,
  onSelectSettingsTab,
  onSelectIdea,
  onSelectLauncherApp,
  onUpdateIdeaValue,
  onUpdateIssueSourceKind,
  onUpdateIssueSourceUrl,
  issueSourceConfig,
  issueSourceDraftKind,
  issueSourceDraftUrl,
  issueSourceError,
  project,
  selectedApp,
  selectedAppLabel,
  selectedExplorerTarget,
  selectedIdea,
  selectedTargetPath,
  selectedTargetIdeas,
  selectedWorktree,
  isIdeasLoading,
  ideas,
  sidebarClosedPaddingLeft,
  onToggleShowClosedIdeas,
  syncErrors,
  worktrees,
  showClosedIdeas
}: ProjectMainPanelProps) {
  const headerSafeInset = isSidebarOpen ? 0 : sidebarClosedPaddingLeft;

  return (
    <div className="m-3 ml-2 flex min-h-0 flex-col overflow-hidden rounded-[2rem] border border-zinc-800/70 bg-app-panel shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
      <div
        className="relative flex h-14 items-center justify-between pr-6"
        style={{
          paddingLeft: isSidebarOpen ? '2rem' : `${sidebarClosedPaddingLeft}px`
        }}
      >
        <div
          className="app-drag absolute inset-y-0 right-0"
          style={{
            left: `${headerSafeInset}px`
          }}
        />

        <div className="app-no-drag relative flex min-w-0 items-center gap-3">
          {project ? (
            groupedProjectsLabel ? (
              <SidebarProjectSelect
                groupName={groupedProjectsLabel}
                projects={groupedProjects}
                selectedProjectId={project.id}
                variant="header"
                onSelectProject={onSelectProject}
              />
            ) : (
              <div className="flex h-10 min-w-0 flex-1 items-center gap-2">
                <span className="w-5 shrink-0 opacity-0" aria-hidden="true">
                  ˅
                </span>
                <Text className="min-w-0 flex-1 truncate text-[24px] font-semibold leading-none tracking-tight text-zinc-100">
                  {project.name}
                </Text>
              </div>
            )
          ) : (
            <Text className="truncate text-[15px] font-semibold text-zinc-100">
              No project selected
            </Text>
          )}
          {project ? (
            <ProjectIssueSourceLinkButton
              kind={issueSourceConfig.kind}
              onPress={onOpenIssueSource}
              url={issueSourceConfig.url}
            />
          ) : null}
        </div>

        {project ? (
          <div className="app-no-drag relative">
            <OpenTargetDropdown
              apps={launcherApps}
              disabled={!project || !selectedTargetPath}
              onOpen={onOpenSelectedTarget}
              onSelectApp={onSelectLauncherApp}
              selectedApp={selectedApp}
              selectedAppLabel={selectedAppLabel}
            />
          </div>
        ) : <div className="w-12" />}
      </div>

      {mainView === 'ideas' ? (
        <ProjectIdeasPanel
          assignedIdeaIds={assignedIdeaIds}
          draftValues={draftValues}
          ideas={ideas}
          isDirty={isDirty}
          isLoading={isIdeasLoading}
          isSaving={isSavingIdea}
          loadError={loadIdeasError}
          onCreateIdea={onCreateIdea}
          onMoveIdeaToWorktree={onMoveIdeaToWorktree}
          onSaveIdea={onSaveIdea}
          onSelectIdea={onSelectIdea}
          onToggleClosedIdeas={onToggleShowClosedIdeas}
          onUpdateIdeaValue={onUpdateIdeaValue}
          project={project}
          selectedIdea={selectedIdea}
          selectedIdeaId={selectedIdea?.id ?? ''}
          showClosedIdeas={showClosedIdeas}
          sidebarClosedPaddingLeft={sidebarClosedPaddingLeft}
          syncErrors={syncErrors}
          worktrees={worktrees}
        />
      ) : mainView === 'settings' ? (
        <ProjectSettingsPanel
          activeTab={activeSettingsTab}
          discoveryRoot={discoveryRoot}
          isIssueSourceLoading={isIssueSourceLoading}
          isIssueSourceSaving={isIssueSourceSaving}
          issueSourceConfig={issueSourceConfig}
          issueSourceDraftKind={issueSourceDraftKind}
          issueSourceDraftUrl={issueSourceDraftUrl}
          issueSourceError={issueSourceError}
          onOpenIssueSource={onOpenIssueSource}
          onSaveIssueSourceConfig={onSaveIssueSourceConfig}
          onSelectTab={onSelectSettingsTab}
          onUpdateIssueSourceKind={onUpdateIssueSourceKind}
          onUpdateIssueSourceUrl={onUpdateIssueSourceUrl}
          project={project}
        />
      ) : mainView === 'worktrees' ? (
        <ProjectWorktreesPanel
          launcherError={launcherError}
          onOpenSelectedTarget={onOpenSelectedTarget}
          project={project}
          selectedExplorerTarget={selectedExplorerTarget}
          selectedTargetPath={selectedTargetPath}
          selectedWorktree={selectedWorktree}
          worktrees={worktrees}
        />
      ) : (
        <ProjectCommandCenter
          assignedIdeaIds={assignedIdeaIds}
          launcherError={launcherError}
          onCreateIdea={onCreateIdea}
          onOpenSelectedTarget={onOpenSelectedTarget}
          onSelectIdea={onSelectIdea}
          project={project}
          selectedExplorerTarget={selectedExplorerTarget}
          selectedTargetPath={selectedTargetPath}
          selectedWorktree={selectedWorktree}
          targetIdeas={selectedTargetIdeas}
        />
      )}
    </div>
  );
}
