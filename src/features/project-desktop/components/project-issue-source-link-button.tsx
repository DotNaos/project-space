import { Button, Tooltip } from '@heroui/react';
import { ExternalLink } from 'lucide-react';

import type { ProjectIssueProviderKind } from '@/shared/electron-api';

import { ProviderLogoIcon } from './provider-logo-icon';

interface ProjectIssueSourceLinkButtonProps {
  kind: ProjectIssueProviderKind;
  onPress(): void;
  url: string;
}

export function ProjectIssueSourceLinkButton({
  kind,
  onPress,
  url
}: ProjectIssueSourceLinkButtonProps) {
  if (!url.trim() || kind === 'unconfigured') {
    return null;
  }

  const label = kind === 'azure-devops' ? 'Open Azure DevOps project' : 'Open GitHub repository';

  return (
    <Tooltip delay={0}>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          variant="ghost"
          aria-label={label}
          onPress={onPress}
          className="h-8 w-8 min-w-0 rounded-xl text-zinc-400 hover:bg-zinc-900/35 hover:text-zinc-100"
        >
          <ProviderLogoIcon kind={kind} className="h-4 w-4" />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content showArrow placement="bottom">
        <Tooltip.Arrow />
        <div className="flex items-center gap-2">
          <ProviderLogoIcon kind={kind} className="h-4 w-4" />
          <span>{url}</span>
          <ExternalLink className="h-3.5 w-3.5" />
        </div>
      </Tooltip.Content>
    </Tooltip>
  );
}
