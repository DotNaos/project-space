import { useEffect, useState } from 'react';

export interface VisualViewportMeasurements {
  layoutHeight: number;
  offsetTop: number;
  viewportHeight: number;
}

export function visualViewportBottomInset({
  layoutHeight,
  offsetTop,
  viewportHeight
}: VisualViewportMeasurements) {
  if (
    !Number.isFinite(layoutHeight)
    || !Number.isFinite(offsetTop)
    || !Number.isFinite(viewportHeight)
  ) {
    return 0;
  }

  return Math.max(0, Math.round(layoutHeight - offsetTop - viewportHeight));
}

export function useMobileVisualViewportInset() {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = () => {
      setInset(visualViewportBottomInset({
        layoutHeight: window.innerHeight,
        offsetTop: viewport.offsetTop,
        viewportHeight: viewport.height
      }));
    };

    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return inset;
}
