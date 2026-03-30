import { Button, Card, Surface, Text } from '@heroui/react';
import { ExternalLink, FolderCog, Settings2 } from 'lucide-react';

import type { ProjectIssueSourceConfig, ProjectSpaceRecord } from '@/shared/electron-api';

import { ProjectIssueSourceCard } from './project-issue-source-card';

export type SettingsTab = 'app' | 'project';

interface ProjectSettingsPanelProps {
  activeTab: SettingsTab;
  discoveryRoot: string;
  isIssueSourceLoading: boolean;
  isIssueSourceSaving: boolean;
  issueSourceConfig: ProjectIssueSourceConfig;
  issueSourceDraftKind: ProjectIssueSourceConfig['kind'];
  issueSourceDraftUrl: string;
  issueSourceError: string;
  onOpenIssueSource(): void;
  onSaveIssueSourceConfig(): void;
  onSelectTab(tab: SettingsTab): void;
  onUpdateIssueSourceKind(kind: ProjectIssueSourceConfig['kind']): void;
  onUpdateIssueSourceUrl(url: string): void;
  project?: ProjectSpaceRecord;
}

function SettingsNavButton({
  active,
  icon,
  label,
  onPress
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onPress(): void;
}) {
  return (
    <Button
      variant="ghost"
      onPress={onPress}
      className={
        active
          ? 'h-11 justify-start gap-3 rounded-2xl bg-zinc-800/80 px-3 text-zinc-50'
          : 'h-11 justify-start gap-3 rounded-2xl px-3 text-zinc-400 hover:bg-zinc-900/35 hover:text-zinc-50'
      }
    >
      {icon}
      <span>{label}</span>
    </Button>
  );
}

function AppSettingsContent({ discoveryRoot }: { discoveryRoot: string }) {
  return (
    <div className="space-y-5">
      <Card variant="secondary" className="border border-zinc-800/80 bg-zinc-950/50">
        <Card.Header className="gap-3">
          <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            App settings
          </Text>
          <Card.Title className="text-2xl font-semibold tracking-tight text-zinc-50">
            Workspace defaults
          </Card.Title>
          <Card.Description className="text-base text-zinc-400">
            Settings here apply to the app itself instead of a single project.
          </Card.Description>
        </Card.Header>
      </Card>

      <Card variant="secondary" className="border border-zinc-800/80 bg-zinc-950/50">
        <Card.Content className="gap-3">
          <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            Projects folder
          </Text>
          <Text className="font-mono text-sm text-zinc-200">
            {discoveryRoot || '~/projects'}
          </Text>
          <Text className="text-sm text-zinc-400">
            This is the folder the app scans to discover your projects and groups.
          </Text>
        </Card.Content>
      </Card>
    </div>
  );
}

function ProjectSettingsContent({
  isIssueSourceLoading,
  isIssueSourceSaving,
  issueSourceConfig,
  issueSourceDraftKind,
  issueSourceDraftUrl,
  issueSourceError,
  onOpenIssueSource,
  onSaveIssueSourceConfig,
  onUpdateIssueSourceKind,
  onUpdateIssueSourceUrl,
  project
}: Omit<ProjectSettingsPanelProps, 'activeTab' | 'discoveryRoot' | 'onSelectTab'>) {
  if (!project) {
    return (
      <Card variant="secondary" className="w-full max-w-xl border border-zinc-800/80 bg-zinc-950/70">
        <Card.Header className="gap-3">
          <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            Project settings
          </Text>
          <Card.Title className="text-2xl font-semibold tracking-tight text-zinc-50">
            Select a project first
          </Card.Title>
          <Card.Description className="text-base text-zinc-400">
            Project settings are saved per project, so pick one before changing where issues live.
          </Card.Description>
        </Card.Header>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Card variant="secondary" className="border border-zinc-800/80 bg-zinc-950/50">
        <Card.Header className="gap-3">
          <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            Project settings
          </Text>
          <Card.Title className="text-2xl font-semibold tracking-tight text-zinc-50">
            {project.name}
          </Card.Title>
          <Card.Description className="text-base text-zinc-400">
            Set the issue provider once for this project. Ideas will use this setting automatically.
          </Card.Description>
        </Card.Header>
      </Card>

      <Card variant="secondary" className="border border-zinc-800/80 bg-zinc-950/50">
        <Card.Content className="space-y-4">
          <ProjectIssueSourceCard
            draftKind={issueSourceDraftKind}
            draftUrl={issueSourceDraftUrl}
            error={issueSourceError}
            isLoading={isIssueSourceLoading}
            isSaving={isIssueSourceSaving}
            onSave={onSaveIssueSourceConfig}
            onUpdateKind={onUpdateIssueSourceKind}
            onUpdateUrl={onUpdateIssueSourceUrl}
          />

          {issueSourceConfig.url ? (
            <Button
              variant="ghost"
              onPress={onOpenIssueSource}
              className="h-10 justify-start rounded-2xl px-3 text-zinc-300 hover:bg-zinc-900/40 hover:text-zinc-50"
            >
              <ExternalLink className="h-4 w-4" strokeWidth={1.8} />
              <span>Open configured source</span>
            </Button>
          ) : null}
        </Card.Content>
      </Card>

      <Surface
        variant="tertiary"
        className="rounded-2xl border border-zinc-800 bg-zinc-950/30 px-4 py-3 text-sm text-zinc-400"
      >
        This setting is saved per project and reused by the ideas backlog, publishing, and repo shortcut buttons.
      </Surface>
    </div>
  );
}

export function ProjectSettingsPanel({
  activeTab,
  discoveryRoot,
  isIssueSourceLoading,
  isIssueSourceSaving,
  issueSourceConfig,
  issueSourceDraftKind,
  issueSourceDraftUrl,
  issueSourceError,
  onOpenIssueSource,
  onSaveIssueSourceConfig,
  onSelectTab,
  onUpdateIssueSourceKind,
  onUpdateIssueSourceUrl,
  project
}: ProjectSettingsPanelProps) {
  return (
    <div className="min-h-0 flex-1 px-8 py-6">
      <div className="mx-auto grid w-full max-w-5xl grid-cols-[220px_minmax(0,1fr)] gap-8">
        <div className="space-y-2">
          <SettingsNavButton
            active={activeTab === 'project'}
            icon={<FolderCog className="h-4 w-4 shrink-0" strokeWidth={1.9} />}
            label="Project settings"
            onPress={() => {
              onSelectTab('project');
            }}
          />
          <SettingsNavButton
            active={activeTab === 'app'}
            icon={<Settings2 className="h-4 w-4 shrink-0" strokeWidth={1.9} />}
            label="App settings"
            onPress={() => {
              onSelectTab('app');
            }}
          />
        </div>

        <div className="min-w-0">
          {activeTab === 'project' ? (
            <ProjectSettingsContent
              isIssueSourceLoading={isIssueSourceLoading}
              isIssueSourceSaving={isIssueSourceSaving}
              issueSourceConfig={issueSourceConfig}
              issueSourceDraftKind={issueSourceDraftKind}
              issueSourceDraftUrl={issueSourceDraftUrl}
              issueSourceError={issueSourceError}
              onOpenIssueSource={onOpenIssueSource}
              onSaveIssueSourceConfig={onSaveIssueSourceConfig}
              onUpdateIssueSourceKind={onUpdateIssueSourceKind}
              onUpdateIssueSourceUrl={onUpdateIssueSourceUrl}
              project={project}
            />
          ) : (
            <AppSettingsContent discoveryRoot={discoveryRoot} />
          )}
        </div>
      </div>
    </div>
  );
}
