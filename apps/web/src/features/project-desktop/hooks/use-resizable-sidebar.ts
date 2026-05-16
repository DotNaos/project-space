import { useEffect, useState } from 'react';

interface UseResizableSidebarOptions {
  initialWidth: number;
  maxWidth: number;
  minWidth: number;
}

export function useResizableSidebar({
  initialWidth,
  maxWidth,
  minWidth
}: UseResizableSidebarOptions) {
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(initialWidth);

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      const nextWidth = Math.max(minWidth, Math.min(maxWidth, event.clientX));

      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, maxWidth, minWidth]);

  return {
    isResizingSidebar: isResizing,
    sidebarWidth,
    startSidebarResize() {
      setIsResizing(true);
    }
  };
}
