import type { CSSProperties } from 'react';
import { Button } from '@/app/dotnaos-ui';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

interface SidebarToggleButtonProps {
  isOpen: boolean;
  left: number;
  top: number;
  onToggle(): void;
}

export function SidebarToggleButton({
  isOpen,
  left,
  top,
  onToggle
}: SidebarToggleButtonProps) {
  const buttonStyle: CSSProperties = {
    left,
    pointerEvents: 'auto',
    top
  };

  return (
    <Button
      aria-label={isOpen ? 'Collapse sidebar' : 'Expand sidebar'}
      data-testid="sidebar-toggle"
      isIconOnly
      variant="ghost"
      onPress={onToggle}
      className="app-no-drag absolute z-50 h-10 w-10 min-w-0 rounded-lg bg-neutral-900/40 px-0 text-neutral-400 transition hover:bg-neutral-800/80 hover:text-neutral-100"
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
