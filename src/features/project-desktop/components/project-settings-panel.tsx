import { Button, Card, Surface, Text } from '@heroui/react';
import { ExternalLink } from 'lucide-react';

import type { ProjectIssueSourceConfig, ProjectSpaceRecord } from '@/shared/electron-api';

import { ProjectIssueSourceCard } from './project-issue-source-card';

interface ProjectSettingsPanelProps {
  isIssueSourceLoading: boolean;
  isIssueSourceSaving: boolean;
  issueSourceConfig: ProjectIssueSourceConfig;
  issueSourceDraftKind: ProjectIssueSourceConfig['kind'];
  issueSourceDraftUrl: string;
  issueSourceError: string;
  onOpenIssueSource(): void;
  onSaveIssueSourceConfig(): void;
  onUpdateIssueSourceKind(kind: ProjectIssueSourceConfig['kind']): void;
  onUpdateIssueSourceUrl(url: string): void;
  project?: ProjectSpaceRecord;
}

export function ProjectSettingsPanel({
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
}: ProjectSettingsPanelProps) {
  if (!project) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8">
        <Card variant="secondary" className="w-full max-w-xl border border-zinc-800/80 bg-zinc-950/70">
          <Card.Header className="gap-3">
            <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
              Project settings
            </Text>
            <Card.Title className="text-2xl font-semibold tracking-tight text-zinc-50">
              Select a project first
            </Card.Title>
            <Card.Description className="text-base text-zinc-400">
              Settings are stored per project, so pick a project before changing where issues live.
            </Card.Description>
          </Card.Header>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 px-8 py-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
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
    </div>
  );
}
