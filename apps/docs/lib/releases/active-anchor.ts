'use client';

let activeAnchor: string | undefined;
const listeners = new Set<() => void>();

export function setActiveReleaseAnchor(value: string | undefined) {
  if (activeAnchor === value) return;
  activeAnchor = value;
  for (const listener of listeners) listener();
}

export function getActiveReleaseAnchor() {
  return activeAnchor;
}

export function subscribeActiveReleaseAnchor(
  listener: () => void,
) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
