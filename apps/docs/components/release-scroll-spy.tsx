'use client';

import { useEffect } from 'react';
import { activeAnchorAtReadingLine } from '@/lib/releases/presentation';

const releaseAnchorEvent = 'project-space:release-anchor';

export function ReleaseScrollSpy({
  anchors,
}: {
  anchors: string[];
}) {
  useEffect(() => {
    let sections: HTMLElement[] = [];
    let frame: number | undefined;
    let connected = false;
    const update = () => {
      frame = undefined;
      const readingLine = Math.min(
        window.innerHeight * 0.28,
        180,
      );
      publishActiveAnchor(
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
      if (anchors.includes(hash)) publishActiveAnchor(hash);
      schedule();
    };
    const connect = () => {
      if (connected) return true;
      sections = anchors
        .map((anchor) => document.getElementById(anchor))
        .filter(
          (element): element is HTMLElement => Boolean(element),
        );
      if (sections.length === 0) return false;
      connected = true;
      syncHash();
      window.addEventListener('hashchange', syncHash);
      window.addEventListener('resize', schedule);
      window.addEventListener('scroll', schedule, {
        passive: true,
      });
      return true;
    };

    let attempts = 0;
    const connectWhenReady = () => {
      frame = undefined;
      attempts += 1;
      if (!connect() && attempts < 60) {
        frame = window.requestAnimationFrame(connectWhenReady);
      }
    };
    connectWhenReady();
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (connected) {
        window.removeEventListener('hashchange', syncHash);
        window.removeEventListener('resize', schedule);
        window.removeEventListener('scroll', schedule);
      }
      delete document.documentElement.dataset.releaseActiveAnchor;
    };
  }, [anchors]);

  return (
    <span
      aria-hidden
      data-release-scroll-anchors={anchors.join(',')}
      data-release-scroll-spy
      hidden
    />
  );
}

function publishActiveAnchor(anchor: string | undefined) {
  if (!anchor) return;
  document.documentElement.dataset.releaseActiveAnchor = anchor;
  window.dispatchEvent(
    new CustomEvent(releaseAnchorEvent, { detail: anchor }),
  );
}
