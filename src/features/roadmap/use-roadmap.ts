import { useCallback, useEffect, useRef, useState } from 'react';

import { projectSpaceClient } from '@/api/project-space-client';
import type {
  RoadmapDependencyMutationRequest,
  RoadmapGoal,
  RoadmapPlanItem,
  RoadmapPlanItemInput,
  RoadmapResult
} from '@/shared/roadmap-api';
import { roadmapAdditionIndex } from '../../shared/roadmap-model';

export interface RoadmapController {
  addDependency(request: Omit<RoadmapDependencyMutationRequest, 'expectedGraphRevision' | 'fullName'>): Promise<boolean>;
  addIssue(issueNumber: number, options?: { goalId?: string; goals?: RoadmapGoal[] }): Promise<boolean>;
  announcement: string;
  error: string;
  isLoading: boolean;
  isSaving: boolean;
  refresh(): void;
  removeDependency(request: Omit<RoadmapDependencyMutationRequest, 'expectedGraphRevision' | 'fullName'>): Promise<boolean>;
  result?: RoadmapResult;
  savePlan(goals: RoadmapGoal[], items: RoadmapPlanItem[]): Promise<boolean>;
}

interface LoadedRoadmap {
  fullName: string;
  result: RoadmapResult;
}

export class RoadmapRequestOrder {
  private revision = 0;

  begin() {
    this.revision += 1;
    return this.revision;
  }

  isCurrent(revision: number) {
    return revision === this.revision;
  }
}

export function roadmapResultForRepository(
  loaded: LoadedRoadmap | undefined,
  fullName: string | undefined
) {
  return loaded && loaded.fullName === fullName ? loaded.result : undefined;
}

export function useRoadmap(fullName?: string): RoadmapController {
  const [loaded, setLoaded] = useState<LoadedRoadmap>();
  const [errorState, setErrorState] = useState<{ fullName?: string; message: string }>({ message: '' });
  const [announcement, setAnnouncement] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [generation, setGeneration] = useState(0);
  const result = roadmapResultForRepository(loaded, fullName);
  const error = errorState.fullName === fullName ? errorState.message : '';
  const fullNameRef = useRef(fullName);
  const requestOrderRef = useRef(new RoadmapRequestOrder());
  const resultRef = useRef(result);
  fullNameRef.current = fullName;
  resultRef.current = result;

  useEffect(() => {
    if (!fullName) {
      setLoaded(undefined);
      setErrorState({ message: '' });
      setIsLoading(false);
      return;
    }
    let canceled = false;
    const requestRevision = requestOrderRef.current.begin();
    setIsLoading(true);
    setErrorState({ fullName, message: '' });
    setAnnouncement('');
    projectSpaceClient.getRoadmap(fullName)
      .then((next) => {
        if (!canceled && requestOrderRef.current.isCurrent(requestRevision)) {
          setLoaded({ fullName, result: next });
          setErrorState({ fullName, message: '' });
        }
      })
      .catch((reason) => {
        if (!canceled && requestOrderRef.current.isCurrent(requestRevision)) setErrorState({
          fullName,
          message: reason instanceof Error ? reason.message : 'Could not load the roadmap.'
        });
      })
      .finally(() => {
        if (!canceled && requestOrderRef.current.isCurrent(requestRevision)) setIsLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [fullName, generation]);

  const acceptMutation = useCallback((next: RoadmapResult, successMessage: string) => {
    if (!fullName || fullNameRef.current !== fullName) return false;
    requestOrderRef.current.begin();
    setIsLoading(false);
    setLoaded({ fullName, result: next });
    if (next.conflict) {
      setErrorState({
        fullName,
        message: next.message ?? 'The roadmap changed elsewhere. Review the latest version.'
      });
      setAnnouncement('Latest roadmap loaded. Your change was not applied.');
      return false;
    }
    setErrorState({ fullName, message: '' });
    setAnnouncement(successMessage);
    return true;
  }, [fullName]);

  const savePlanInputs = useCallback(async (
    goals: RoadmapGoal[],
    items: RoadmapPlanItemInput[]
  ) => {
    const current = resultRef.current;
    if (!fullName || !current) return false;
    requestOrderRef.current.begin();
    setIsSaving(true);
    setErrorState({ fullName, message: '' });
    try {
      const next = await projectSpaceClient.updateRoadmapPlan({
        expectedGraphRevision: current.graphRevision,
        expectedRevision: current.plan.revision,
        fullName,
        goals,
        items
      });
      return acceptMutation(next, 'Roadmap plan saved.');
    } catch (reason) {
      setErrorState({
        fullName,
        message: reason instanceof Error ? reason.message : 'Could not save the roadmap plan.'
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [acceptMutation, fullName]);

  const savePlan = useCallback((goals: RoadmapGoal[], items: RoadmapPlanItem[]) => (
    savePlanInputs(goals, items.map((item) => ({
      goalId: item.goalId,
      issueNumber: item.issue.number,
      plannedState: item.plannedState
    })))
  ), [savePlanInputs]);

  const addIssue = useCallback((
    issueNumber: number,
    options: { goalId?: string; goals?: RoadmapGoal[] } = {}
  ) => {
    const current = resultRef.current;
    if (!current || current.plan.items.some((item) => item.issue.number === issueNumber)) {
      return Promise.resolve(false);
    }
    const issue = current.issues.find((node) => (
      node.issue.number === issueNumber
      && node.issue.fullName.toLowerCase() === current.repository.fullName.toLowerCase()
    ));
    const insertionIndex = issue
      ? roadmapAdditionIndex(current.plan.items, current.dependencies, issue.issue)
      : current.plan.items.length;
    if (insertionIndex === undefined) return Promise.resolve(false);
    const items = current.plan.items.map((item) => ({
        goalId: item.goalId,
        issueNumber: item.issue.number,
        plannedState: item.plannedState
      }));
    items.splice(insertionIndex, 0, {
      goalId: options.goalId,
      issueNumber,
      plannedState: 'planned'
    });
    return savePlanInputs(options.goals ?? current.plan.goals, items);
  }, [savePlanInputs]);

  const mutateDependency = useCallback(async (
    operation: 'add' | 'remove',
    request: Omit<RoadmapDependencyMutationRequest, 'expectedGraphRevision' | 'fullName'>
  ) => {
    const current = resultRef.current;
    if (!fullName || !current) return false;
    requestOrderRef.current.begin();
    setIsSaving(true);
    setErrorState({ fullName, message: '' });
    try {
      const payload = {
        ...request,
        expectedGraphRevision: current.graphRevision,
        fullName
      };
      const next = operation === 'add'
        ? await projectSpaceClient.addRoadmapDependency(payload)
        : await projectSpaceClient.removeRoadmapDependency(payload);
      return acceptMutation(next, operation === 'add' ? 'Prerequisite added.' : 'Prerequisite removed.');
    } catch (reason) {
      setErrorState({
        fullName,
        message: reason instanceof Error ? reason.message : 'Could not update the prerequisite.'
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [acceptMutation, fullName]);

  return {
    addDependency: (request) => mutateDependency('add', request),
    addIssue,
    announcement,
    error,
    isLoading: isLoading || Boolean(fullName && loaded?.fullName !== fullName),
    isSaving,
    refresh: () => setGeneration((value) => value + 1),
    removeDependency: (request) => mutateDependency('remove', request),
    result,
    savePlan
  };
}
