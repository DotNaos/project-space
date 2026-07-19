import { homedir } from 'node:os';
import { join } from 'node:path';

import { getRoadmapPlanStore as getDatabaseRoadmapPlanStore } from '../local-database-store';
import { LocalRoadmapPlanStore } from './local-roadmap-store';

const localRoadmapPlanStore = new LocalRoadmapPlanStore(
  join(homedir(), '.project-space', 'roadmap-plans.json')
);

export async function getRoadmapPlanStore() {
  return (await getDatabaseRoadmapPlanStore()) ?? localRoadmapPlanStore;
}
