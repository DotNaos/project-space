import type { CSSProperties } from 'react';
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
    <button
      type="button"
      aria-label={isOpen ? 'Close sidebar' : 'Open sidebar'}
      onClick={onToggle}
      className="app-no-drag absolute z-40 flex h-8 w-8 items-center justify-center text-slate-500 transition hover:text-slate-50"
      style={buttonStyle}
    >
      {isOpen ? (
        <PanelLeftClose className="h-[18px] w-[18px]" strokeWidth={1.9} />
      ) : (
        <PanelLeftOpen className="h-[18px] w-[18px]" strokeWidth={1.9} />
      )}
    </button>
  );
}
