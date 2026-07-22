import { useCallback, useEffect, useRef, useState } from 'react';

import { projectSpaceClient } from '@/api/project-space-client';
import type { GitHubIssueRecord } from '@/shared/project-space-api';
import type {
  RoadmapDependencyMutationRequest,
  RoadmapGoal,
  RoadmapPlanItem,
  RoadmapPlanItemInput,
  RoadmapResult
} from '@/shared/roadmap-api';
import { validRoadmapAdditionRange } from '../../shared/roadmap-model';
import {
  optimisticRoadmapDependency,
  optimisticRoadmapPlan,
  roadmapDependencyMutationIssueIds
} from './roadmap-optimistic';

export interface RoadmapController {
  addDependency(request: Omit<RoadmapDependencyMutationRequest, 'expectedGraphRevision' | 'fullName'>): Promise<boolean>;
  addIssue(issueNumber: number, options?: {
    goalId?: string;
    goals?: RoadmapGoal[];
    insertionIndex?: number;
    issue?: GitHubIssueRecord;
  }): Promise<boolean>;
  announcement: string;
  error: string;
  isLoading: boolean;
  isSaving: boolean;
  pendingIssueIds: ReadonlySet<number>;
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

export class RoadmapMutationOrder extends RoadmapRequestOrder {
  cancel() {
    this.begin();
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
  const [pendingIssueIds, setPendingIssueIds] = useState<ReadonlySet<number>>(() => new Set());
  const [generation, setGeneration] = useState(0);
  const result = roadmapResultForRepository(loaded, fullName);
  const error = errorState.fullName === fullName ? errorState.message : '';
  const fullNameRef = useRef(fullName);
  const requestOrderRef = useRef(new RoadmapRequestOrder());
  const mutationOrderRef = useRef(new RoadmapMutationOrder());
  const isSavingRef = useRef(false);
  const resultRef = useRef(result);
  fullNameRef.current = fullName;
  resultRef.current = result;

  useEffect(() => {
    mutationOrderRef.current.cancel();
    isSavingRef.current = false;
    setIsSaving(false);
    setPendingIssueIds(new Set());
  }, [fullName]);

  useEffect(() => {
    if (!fullName) {
      setLoaded(undefined);
      setErrorState({ message: '' });
      setIsLoading(false);
      setIsSaving(false);
      setPendingIssueIds(new Set());
      isSavingRef.current = false;
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
    items: RoadmapPlanItemInput[],
    options: { addedIssue?: GitHubIssueRecord; pendingIssueIds?: number[] } = {}
  ) => {
    const current = resultRef.current;
    if (!fullName || !current || isSavingRef.current) return false;
    const mutation = mutationOrderRef.current.begin();
    requestOrderRef.current.begin();
    const optimistic = optimisticRoadmapPlan(current, goals, items, options.addedIssue);
    resultRef.current = optimistic;
    setLoaded({ fullName, result: optimistic });
    isSavingRef.current = true;
    setIsSaving(true);
    setPendingIssueIds(new Set(options.pendingIssueIds ?? []));
    setErrorState({ fullName, message: '' });
    setAnnouncement('Saving roadmap…');
    try {
      const next = await projectSpaceClient.updateRoadmapPlan({
        expectedGraphRevision: current.graphRevision,
        expectedRevision: current.plan.revision,
        fullName,
        goals,
        items
      });
      if (fullNameRef.current !== fullName || !mutationOrderRef.current.isCurrent(mutation)) return false;
      return acceptMutation(next, 'Roadmap plan saved.');
    } catch (reason) {
      if (fullNameRef.current !== fullName || !mutationOrderRef.current.isCurrent(mutation)) return false;
      resultRef.current = current;
      setLoaded({ fullName, result: current });
      setErrorState({
        fullName,
        message: reason instanceof Error
          ? `${reason.message} Your roadmap change was undone.`
          : 'Could not save the roadmap plan. Your change was undone.'
      });
      setAnnouncement('Save failed. The roadmap was restored.');
      setGeneration((value) => value + 1);
      return false;
    } finally {
      if (fullNameRef.current === fullName && mutationOrderRef.current.isCurrent(mutation)) {
        isSavingRef.current = false;
        setIsSaving(false);
        setPendingIssueIds(new Set());
      }
    }
  }, [acceptMutation, fullName]);

  const savePlan = useCallback((goals: RoadmapGoal[], items: RoadmapPlanItem[]) => (
    savePlanInputs(goals, items.map((item) => ({
      goalId: item.goalId,
      issueNumber: item.issue.number,
      plannedState: item.plannedState
    })), { pendingIssueIds: items.map((item) => item.issue.id) })
  ), [savePlanInputs]);

  const addIssue = useCallback((
    issueNumber: number,
    options: {
      goalId?: string;
      goals?: RoadmapGoal[];
      insertionIndex?: number;
      issue?: GitHubIssueRecord;
    } = {}
  ) => {
    const current = resultRef.current;
    if (!current || current.plan.items.some((item) => item.issue.number === issueNumber)) {
      return Promise.resolve(false);
    }
    const issue = current.issues.find((node) => (
      node.issue.number === issueNumber
      && node.issue.fullName.toLowerCase() === current.repository.fullName.toLowerCase()
    ));
    const optimisticIssue = options.issue ?? (!issue ? {
      id: -Math.max(1, issueNumber),
      labels: [],
      number: issueNumber,
      state: 'open' as const,
      title: `Issue #${issueNumber}`,
      url: `https://github.com/${current.repository.fullName}/issues/${issueNumber}`
    } : undefined);
    const additionIssue = issue?.issue ?? (optimisticIssue ? {
      fullName: current.repository.fullName,
      id: optimisticIssue.id ?? -Math.max(1, optimisticIssue.number),
      number: optimisticIssue.number,
      url: optimisticIssue.url
    } : undefined);
    const range = additionIssue
      ? validRoadmapAdditionRange(current.plan.items, current.dependencies, additionIssue)
      : { maximum: current.plan.items.length, minimum: 0 };
    const insertionIndex = options.insertionIndex ?? range?.maximum;
    if (!range || insertionIndex === undefined
      || insertionIndex < range.minimum || insertionIndex > range.maximum) {
      return Promise.resolve(false);
    }
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
    return savePlanInputs(options.goals ?? current.plan.goals, items, {
      addedIssue: optimisticIssue,
      pendingIssueIds: additionIssue ? [additionIssue.id] : []
    });
  }, [savePlanInputs]);

  const mutateDependency = useCallback(async (
    operation: 'add' | 'remove',
    request: Omit<RoadmapDependencyMutationRequest, 'expectedGraphRevision' | 'fullName'>
  ) => {
    const current = resultRef.current;
    if (!fullName || !current || isSavingRef.current) return false;
    const mutation = mutationOrderRef.current.begin();
    requestOrderRef.current.begin();
    const optimistic = optimisticRoadmapDependency(current, operation, request);
    resultRef.current = optimistic;
    setLoaded({ fullName, result: optimistic });
    isSavingRef.current = true;
    setIsSaving(true);
    setPendingIssueIds(new Set(roadmapDependencyMutationIssueIds(current, request)));
    setErrorState({ fullName, message: '' });
    setAnnouncement(operation === 'add' ? 'Adding prerequisite…' : 'Removing prerequisite…');
    try {
      const payload = {
        ...request,
        expectedGraphRevision: current.graphRevision,
        fullName
      };
      const next = operation === 'add'
        ? await projectSpaceClient.addRoadmapDependency(payload)
        : await projectSpaceClient.removeRoadmapDependency(payload);
      if (fullNameRef.current !== fullName || !mutationOrderRef.current.isCurrent(mutation)) return false;
      return acceptMutation(next, operation === 'add' ? 'Prerequisite added.' : 'Prerequisite removed.');
    } catch (reason) {
      if (fullNameRef.current !== fullName || !mutationOrderRef.current.isCurrent(mutation)) return false;
      resultRef.current = current;
      setLoaded({ fullName, result: current });
      setErrorState({
        fullName,
        message: reason instanceof Error
          ? `${reason.message} The relationship change was undone.`
          : 'Could not update the prerequisite. The relationship change was undone.'
      });
      setAnnouncement('Relationship save failed. The roadmap was restored.');
      setGeneration((value) => value + 1);
      return false;
    } finally {
      if (fullNameRef.current === fullName && mutationOrderRef.current.isCurrent(mutation)) {
        isSavingRef.current = false;
        setIsSaving(false);
        setPendingIssueIds(new Set());
      }
    }
  }, [acceptMutation, fullName]);

  return {
    addDependency: (request) => mutateDependency('add', request),
    addIssue,
    announcement,
    error,
    isLoading: isLoading || Boolean(fullName && loaded?.fullName !== fullName),
    isSaving,
    pendingIssueIds,
    refresh: () => {
      if (!isSavingRef.current) setGeneration((value) => value + 1);
    },
    removeDependency: (request) => mutateDependency('remove', request),
    result,
    savePlan
  };
}
