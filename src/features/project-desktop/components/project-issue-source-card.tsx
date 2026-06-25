import {
  Button,
  Input,
  ListBox,
  ListBoxItem,
  Select,
  Text
} from '@heroui/react';
import { RefreshCw, Save } from 'lucide-react';

import type { ProjectIssueProviderKind } from '@/shared/electron-api';

interface ProjectIssueSourceCardProps {
  draftKind: ProjectIssueProviderKind;
  draftUrl: string;
  error: string;
  isLoading: boolean;
  isSaving: boolean;
  onSave(): void;
  onUpdateKind(kind: ProjectIssueProviderKind): void;
  onUpdateUrl(url: string): void;
}

export function ProjectIssueSourceCard({
  draftKind,
  draftUrl,
  error,
  isLoading,
  isSaving,
  onSave,
  onUpdateKind,
  onUpdateUrl
}: ProjectIssueSourceCardProps) {
  return (
    <div className="space-y-4">
      <div>
        <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          Issue source
        </Text>
        <Text className="mt-2 text-sm text-zinc-400">
          Decide whether this project reads and publishes ideas through GitHub or Azure DevOps.
          GitHub projects use the app-level GitHub connection from App settings.
        </Text>
      </div>

      <div className="space-y-2">
        <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          Provider
        </Text>
        <Select
          aria-label="Issue provider"
          className="w-full"
          value={draftKind === 'unconfigured' ? 'github' : draftKind}
          variant="secondary"
          onChange={(value) => {
            if (value === 'github' || value === 'azure-devops') {
              onUpdateKind(value);
            }
          }}
        >
          <Select.Trigger className="min-h-10 rounded-xl border border-zinc-800/70 bg-zinc-950/30 px-3 text-left text-zinc-200">
            <Select.Value>
              {draftKind === 'azure-devops' ? 'Azure DevOps' : 'GitHub'}
            </Select.Value>
            <Select.Indicator className="text-zinc-500" />
          </Select.Trigger>
          <Select.Popover className="min-w-[220px] rounded-2xl border border-zinc-800/70 bg-zinc-900/90">
            <ListBox aria-label="Issue provider options" selectionMode="single">
              <ListBoxItem id="github" textValue="GitHub" className="rounded-xl text-zinc-200">
                GitHub
              </ListBoxItem>
              <ListBoxItem id="azure-devops" textValue="Azure DevOps" className="rounded-xl text-zinc-200">
                Azure DevOps
              </ListBoxItem>
            </ListBox>
          </Select.Popover>
        </Select>
      </div>

      <div className="space-y-2">
        <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          Repository or project URL
        </Text>
        <Input
          placeholder={
            draftKind === 'azure-devops'
              ? 'https://dev.azure.com/org/project'
              : 'https://github.com/owner/repo'
          }
          value={draftUrl}
          onChange={(event) => {
            onUpdateUrl(event.currentTarget.value);
          }}
        />
      </div>

      {error ? (
        <Text className="text-sm text-zinc-300">{error}</Text>
      ) : null}

      <Button
        variant="secondary"
        isDisabled={!draftUrl.trim() || isLoading || isSaving}
        onPress={onSave}
        className="h-10 rounded-2xl px-3 text-zinc-100"
      >
        {isSaving ? (
          <RefreshCw className="h-4 w-4 animate-spin" strokeWidth={1.9} />
        ) : (
          <Save className="h-4 w-4" strokeWidth={1.9} />
        )}
        <span>Save source</span>
      </Button>
    </div>
  );
}
