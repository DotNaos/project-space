import { Bot, ChevronRight, MessagesSquare } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import {
  projectChatBreadcrumbs,
  type ProjectChatTarget
} from './project-space-information-architecture';

export interface ProjectChatCommandCenterProps {
  className?: string;
  children: ReactNode;
  onOpen(target: ProjectChatTarget): void;
  target: ProjectChatTarget;
}

export function ProjectChatCommandCenter({
  children,
  className,
  onOpen,
  target
}: ProjectChatCommandCenterProps) {
  const breadcrumbs = projectChatBreadcrumbs(target);

  return (
    <section
      aria-label="Chat"
      className={cn('flex size-full min-h-0 flex-col bg-app-panel', className)}
      data-chat-layer={target.kind}
      data-testid="project-chat-command-center"
    >
      <header className="app-no-drag flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-800 px-3">
        <MessagesSquare aria-hidden="true" className="mr-1 size-4 shrink-0 text-neutral-500" />
        {breadcrumbs.map((crumb, index) => (
          <span className="flex min-w-0 items-center gap-1" key={crumb.id}>
            {index > 0 ? (
              <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-neutral-600" />
            ) : null}
            <Button
              className="h-8 min-h-0 max-w-48 px-2"
              isDisabled={index === breadcrumbs.length - 1}
              onPress={() => onOpen(crumb.target)}
              size="sm"
              variant="ghost"
            >
              {crumb.target.kind === 'agent' ? (
                <Bot aria-hidden="true" className="size-3.5 shrink-0" />
              ) : null}
              <Text className="truncate text-xs">{crumb.label}</Text>
            </Button>
          </span>
        ))}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
