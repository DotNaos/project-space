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
import { ProjectIdeasPanel } from './project-ideas-panel';
import { ProjectIssueSourceLinkButton } from './project-issue-source-link-button';
import { ProjectSettingsPanel, type SettingsTab } from './project-settings-panel';
import { SidebarProjectSelect } from './sidebar-project-select';

export type ProjectMainView = 'ideas' | 'settings' | 'workspace';

interface ProjectMainPanelProps {
  activeSettingsTab: SettingsTab;
  discoveryRoot: string;
  draftValues: EditableIdeaValues;
  groupedProjects: ProjectSpaceRecord[];
  groupedProjectsLabel?: string;
  ideaExportMessage: string;
  ideas: IdeaPresentationRecord[];
  isDirty: boolean;
  isIdeaExporting: boolean;
  isIssueSourceLoading: boolean;
  isIssueSourceSaving: boolean;
  isLoadingIdeas: boolean;
  isSavingIdea: boolean;
  isSidebarOpen: boolean;
  launcherApps: LauncherAppRecord[];
  launcherError: string;
  loadIdeasError: string;
  mainView: ProjectMainView;
  onCreateIdea(): void;
  onCreateProject(): void;
  onExportIdeaToWorktree(): void;
  onOpenIssueSource(): void;
  onOpenSelectedTarget(): void;
  onSaveIdea(): void;
  onSaveIssueSourceConfig(): void;
  onSelectProject(projectId: string): void;
  onSelectSettingsTab(tab: SettingsTab): void;
  onSelectIdea(ideaId: string): void;
  onSelectLauncherApp(appId: string): void;
  onToggleClosedIdeas(nextValue: boolean): void;
  onUpdateIdeaValue<Key extends keyof EditableIdeaValues>(
    key: Key,
    value: EditableIdeaValues[Key]
  ): void;
  onUpdateIssueSourceKind(kind: ProjectIssueSourceConfig['kind']): void;
  onUpdateIssueSourceUrl(url: string): void;
  issueSourceConfig: ProjectIssueSourceConfig;
  issueSourceDraftKind: ProjectIssueSourceConfig['kind'];
  issueSourceDraftUrl: string;
  issueSourceError: string;
  project?: ProjectSpaceRecord;
  selectedApp?: LauncherAppRecord;
  selectedAppLabel?: string;
  selectedExplorerTarget: ExplorerTarget;
  selectedIdea?: IdeaPresentationRecord;
  selectedIdeaId: string;
  selectedTargetName: string;
  selectedTargetPath: string;
  selectedWorktree?: ProjectWorktreeRecord;
  showClosedIdeas: boolean;
  sidebarClosedPaddingLeft: number;
  syncErrors: Record<string, string>;
}

function WorkspaceMainPanel({
  discoveryRoot,
  launcherApps,
  launcherError,
  onCreateProject,
  onOpenSelectedTarget,
  onSelectLauncherApp,
  project,
  selectedApp,
  selectedAppLabel,
  selectedExplorerTarget,
  selectedTargetName,
  selectedTargetPath
}: Pick<
  ProjectMainPanelProps,
  | 'discoveryRoot'
  | 'launcherApps'
  | 'launcherError'
  | 'onCreateProject'
  | 'onOpenSelectedTarget'
  | 'onSelectLauncherApp'
  | 'project'
  | 'selectedApp'
  | 'selectedAppLabel'
  | 'selectedExplorerTarget'
  | 'selectedTargetName'
  | 'selectedTargetPath'
>) {
  const targetLabel =
    selectedExplorerTarget.kind === 'worktree' ? 'Worktree Path' : 'Workspace Path';

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-8">
      <div className="w-full max-w-2xl">
        {project ? (
          <Card variant="secondary" className="border border-zinc-800/80 bg-zinc-950/70">
            <Card.Header className="gap-3">
              <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                {targetLabel}
              </Text>
              <Card.Title className="font-mono text-xl font-medium tracking-tight text-zinc-50">
                {selectedTargetPath}
              </Card.Title>
            </Card.Header>
            <Card.Content className="gap-3">
              <Card.Description className="text-sm text-zinc-400">
                Open the currently selected target directly in your chosen app.
              </Card.Description>
              {launcherError ? (
                <Surface
                  variant="tertiary"
                  className="rounded-2xl border border-zinc-400/20 bg-zinc-500/8 px-4 py-3 text-sm text-zinc-300"
                >
                  {launcherError}
                </Surface>
              ) : null}
            </Card.Content>
          </Card>
        ) : (
          <Card variant="secondary" className="border border-zinc-800/80 bg-zinc-950/70">
            <Card.Header className="gap-3">
              <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                No Projects
              </Text>
              <Card.Title className="text-2xl font-semibold tracking-tight text-zinc-50">
                Nothing selected yet
              </Card.Title>
              <Card.Description className="text-base text-zinc-400">
                Add projects under {discoveryRoot || '~/projects'} to discover them.
              </Card.Description>
            </Card.Header>
            <Card.Footer>
              <Button variant="outline" onPress={onCreateProject}>
                Select project
              </Button>
            </Card.Footer>
          </Card>
        )}
      </div>
    </div>
  );
}

export function ProjectMainPanel({
  activeSettingsTab,
  discoveryRoot,
  draftValues,
  groupedProjects,
  groupedProjectsLabel,
  ideaExportMessage,
  ideas,
  isDirty,
  isIdeaExporting,
  isIssueSourceLoading,
  isIssueSourceSaving,
  isLoadingIdeas,
  isSavingIdea,
  isSidebarOpen,
  launcherApps,
  launcherError,
  loadIdeasError,
  mainView,
  onCreateIdea,
  onCreateProject,
  onExportIdeaToWorktree,
  onOpenIssueSource,
  onOpenSelectedTarget,
  onSaveIdea,
  onSaveIssueSourceConfig,
  onSelectProject,
  onSelectSettingsTab,
  onSelectIdea,
  onSelectLauncherApp,
  onToggleClosedIdeas,
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
  selectedIdeaId,
  selectedTargetName,
  selectedTargetPath,
  selectedWorktree,
  showClosedIdeas,
  sidebarClosedPaddingLeft,
  syncErrors
}: ProjectMainPanelProps) {
  const headerSafeInset = isSidebarOpen ? 0 : sidebarClosedPaddingLeft;

  return (
    <Surface variant="transparent" className="flex min-h-0 flex-col rounded-none bg-app-panel">
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
          draftValues={draftValues}
          ideaExportMessage={ideaExportMessage}
          ideas={ideas}
          isDirty={isDirty}
          isIdeaExporting={isIdeaExporting}
          isLoading={isLoadingIdeas}
          isSaving={isSavingIdea}
          loadError={loadIdeasError}
          onCreateIdea={onCreateIdea}
          onExportIdeaToWorktree={onExportIdeaToWorktree}
          onSaveIdea={onSaveIdea}
          onSelectIdea={onSelectIdea}
          onToggleClosedIssues={onToggleClosedIdeas}
          onUpdateIdeaValue={onUpdateIdeaValue}
          project={project}
          selectedIdea={selectedIdea}
          selectedIdeaId={selectedIdeaId}
          selectedWorktree={selectedWorktree}
          showClosedIssues={showClosedIdeas}
          sidebarClosedPaddingLeft={sidebarClosedPaddingLeft}
          syncErrors={syncErrors}
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
      ) : (
        <WorkspaceMainPanel
          discoveryRoot={discoveryRoot}
          launcherApps={launcherApps}
          launcherError={launcherError}
          onCreateProject={onCreateProject}
          onOpenSelectedTarget={onOpenSelectedTarget}
          onSelectLauncherApp={onSelectLauncherApp}
          project={project}
          selectedApp={selectedApp}
          selectedAppLabel={selectedAppLabel}
          selectedExplorerTarget={selectedExplorerTarget}
          selectedTargetName={selectedTargetName}
          selectedTargetPath={selectedTargetPath}
        />
      )}
    </Surface>
  );
}
