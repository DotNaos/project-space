import type { RoadmapIssueAvailability } from '@/shared/roadmap-api';

export const roadmapStatusLabel: Record<RoadmapIssueAvailability, string> = {
  blocked: 'Blocked',
  closed: 'Closed',
  cyclic: 'Cycle',
  inaccessible: 'Inaccessible',
  missing: 'Missing',
  ready: 'Ready next',
  stale: 'Needs refresh'
};

export const roadmapStatusClass: Record<RoadmapIssueAvailability, string> = {
  blocked: 'bg-amber-400',
  closed: 'bg-neutral-600',
  cyclic: 'bg-rose-400',
  inaccessible: 'bg-violet-400',
  missing: 'bg-neutral-500',
  ready: 'bg-emerald-400',
  stale: 'bg-sky-400'
};
