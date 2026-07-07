import { useEffect, useRef, useState } from 'react';

interface UsePaneResizeOptions {
  axis: 'x' | 'y';
  initialSize: number;
  /** Grow the pane when dragging toward the start of the axis (e.g. a bottom pane resized from its top edge). */
  invert?: boolean;
  maxSize: number;
  minSize: number;
}

export function usePaneResize({
  axis,
  initialSize,
  invert = false,
  maxSize,
  minSize
}: UsePaneResizeOptions) {
  const [size, setSize] = useState(initialSize);
  const [isResizing, setIsResizing] = useState(false);
  const dragStart = useRef({ pointer: 0, size: initialSize });

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      const pointer = axis === 'x' ? event.clientX : event.clientY;
      const delta = pointer - dragStart.current.pointer;
      const next = dragStart.current.size + (invert ? -delta : delta);

      setSize(Math.max(minSize, Math.min(maxSize, next)));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [axis, invert, isResizing, maxSize, minSize]);

  return {
    isResizing,
    size,
    startResize(event: { clientX: number; clientY: number; preventDefault(): void }) {
      event.preventDefault();
      dragStart.current = { pointer: axis === 'x' ? event.clientX : event.clientY, size };
      setIsResizing(true);
    }
  };
}
