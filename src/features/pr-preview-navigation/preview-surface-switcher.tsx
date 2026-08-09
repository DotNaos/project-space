import { Button, ButtonGroup } from '@heroui/react';
import { AppWindow, DraftingCompass } from 'lucide-react';

import { cn } from '../../lib/utils';
import { previewSurfaceUrl, type PreviewSurface } from '../../shared/preview-access-gate';

export function PreviewSurfaceSwitcher({
  className,
  current,
  pullRequestNumber
}: {
  className?: string;
  current: PreviewSurface;
  pullRequestNumber: number;
}) {
  const currentOrigin = typeof window === 'undefined' ? undefined : window.location.origin;
  const fullPreviewUrl = previewSurfaceUrl(pullRequestNumber, 'full', currentOrigin);
  const prototypeUrl = previewSurfaceUrl(pullRequestNumber, 'prototype', currentOrigin);
  if (!fullPreviewUrl || !prototypeUrl) return null;

  const navigate = (url: string) => {
    if (url !== window.location.href) window.location.assign(url);
  };

  return (
    <nav
      aria-label="PR preview surface"
      className={cn(
        'app-no-drag rounded-xl border border-white/[.09] bg-neutral-950/90 p-1 shadow-xl backdrop-blur-xl',
        className
      )}
    >
      <ButtonGroup aria-label="Choose PR preview surface" size="sm" variant="ghost">
        <Button
          aria-current={current === 'full' ? 'page' : undefined}
          aria-pressed={current === 'full'}
          className={cn(
            'h-8 gap-1.5 rounded-lg px-2.5 text-xs',
            current === 'full' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500'
          )}
          onPress={() => navigate(fullPreviewUrl)}
        >
          <AppWindow aria-hidden className="size-3.5" />
          Full preview
        </Button>
        <Button
          aria-current={current === 'prototype' ? 'page' : undefined}
          aria-pressed={current === 'prototype'}
          className={cn(
            'h-8 gap-1.5 rounded-lg px-2.5 text-xs',
            current === 'prototype' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500'
          )}
          onPress={() => navigate(prototypeUrl)}
        >
          <DraftingCompass aria-hidden className="size-3.5" />
          Prototype
        </Button>
      </ButtonGroup>
    </nav>
  );
}
