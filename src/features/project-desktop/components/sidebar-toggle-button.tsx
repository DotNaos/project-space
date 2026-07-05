import type { CSSProperties } from 'react';
import { Button } from '@/app/dotnaos-ui';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SidebarToggleButtonProps {
  isOpen: boolean;
  left?: number;
  position?: 'absolute' | 'static';
  top?: number;
  onToggle(): void;
}

export function SidebarToggleButton({
  isOpen,
  left = 0,
  position = 'absolute',
  top = 0,
  onToggle
}: SidebarToggleButtonProps) {
  const buttonStyle: CSSProperties =
    position === 'absolute'
      ? {
          left,
          pointerEvents: 'auto',
          top
        }
      : { pointerEvents: 'auto' };

  return (
    <Button
      aria-label={isOpen ? 'Collapse sidebar' : 'Expand sidebar'}
      data-testid="sidebar-toggle"
      isIconOnly
      variant="ghost"
      onPress={onToggle}
      className={cn(
        'app-no-drag z-50 h-10 w-10 min-w-0 rounded-lg bg-neutral-900/40 px-0 text-neutral-400 transition hover:bg-neutral-800/80 hover:text-neutral-100',
        position === 'absolute' && 'absolute'
      )}
      style={buttonStyle}
    >
      {isOpen ? (
        <PanelLeftClose className="h-5 w-5" strokeWidth={1.9} />
      ) : (
        <PanelLeftOpen className="h-5 w-5" strokeWidth={1.9} />
      )}
    </Button>
  );
}
