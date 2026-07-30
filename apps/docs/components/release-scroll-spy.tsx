'use client';

import { useEffect } from 'react';
import { setActiveReleaseAnchor } from '@/lib/releases/active-anchor';
import { activeAnchorAtReadingLine } from '@/lib/releases/presentation';

export function ReleaseScrollSpy({
  anchors,
}: {
  anchors: string[];
}) {
  useEffect(() => {
    const sections = anchors
      .map((anchor) => document.getElementById(anchor))
      .filter((element): element is HTMLElement => Boolean(element));
    if (sections.length === 0) return;

    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const readingLine = Math.min(
        window.innerHeight * 0.28,
        180,
      );
      setActiveReleaseAnchor(
        activeAnchorAtReadingLine(
          sections.map((section) => ({
            id: section.id,
            top: section.getBoundingClientRect().top,
          })),
          readingLine,
        ),
      );
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };
    const syncHash = () => {
      const hash = window.location.hash.slice(1);
      if (anchors.includes(hash)) {
        setActiveReleaseAnchor(hash);
      }
      schedule();
    };

    syncHash();
    window.addEventListener('hashchange', syncHash);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true });
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', syncHash);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule);
      setActiveReleaseAnchor(undefined);
    };
  }, [anchors]);

  return null;
}
