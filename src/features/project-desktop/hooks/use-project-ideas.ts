import { useEffect, useMemo, useState } from 'react';

import type { ProjectIssueSourceConfig, ProjectSpaceRecord } from '@/shared/electron-api';

import {
  applyIdeaValues,
  toEditableIdeaValues,
  toGithubIdea,
  toIdeaPresentationRecord,
  toLocalIdeaDraft,
  type EditableIdeaValues,
  type IdeaPresentationRecord
} from '../lib/idea-utils';

function mergeIdeas(ideas: IdeaPresentationRecord[]) {
  const byId = new Map<string, IdeaPresentationRecord>();

  for (const idea of ideas) {
    const current = byId.get(idea.id);

    if (!current || idea.source === 'github') {
      byId.set(idea.id, idea);
    }
  }

  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function useProjectIdeas(
  project: ProjectSpaceRecord | undefined,
  issueSourceConfig: ProjectIssueSourceConfig
) {
  const [ideas, setIdeas] = useState<IdeaPresentationRecord[]>([]);
  const [pendingIdea, setPendingIdea] = useState<IdeaPresentationRecord>();
  const [selectedIdeaId, setSelectedIdeaId] = useState('');
  const [draftValues, setDraftValues] = useState<EditableIdeaValues>(
    toEditableIdeaValues(undefined)
  );
  const [isDirty, setIsDirty] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [showClosedIssues, setShowClosedIssues] = useState(true);
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!project) {
      setIdeas([]);
      setPendingIdea(undefined);
      setSelectedIdeaId('');
      setDraftValues(toEditableIdeaValues(undefined));
      setIsDirty(false);
      setLoadError('');
      return;
    }

    let canceled = false;

    setIsLoading(true);
    setLoadError('');

    const githubIdeasPromise =
      issueSourceConfig.kind === 'github'
        ? window.projectSpace.listGithubIdeas({
            includeClosed: showClosedIssues,
            projectPath: project.rootPath
          })
        : Promise.resolve([]);

    void Promise.all([window.projectSpace.loadLocalIdeaDrafts(project.rootPath), githubIdeasPromise])
      .then(([localDrafts, githubIdeas]) => {
        if (canceled) {
          return;
        }

        setPendingIdea(undefined);
        setIdeas(
          mergeIdeas([
            ...localDrafts.map(toIdeaPresentationRecord),
            ...githubIdeas.map(toIdeaPresentationRecord)
          ])
        );
      })
      .catch((error) => {
        if (canceled) {
          return;
        }

        setLoadError(error instanceof Error ? error.message : 'Could not load ideas.');
      })
      .finally(() => {
        if (!canceled) {
          setIsLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [issueSourceConfig.kind, project?.rootPath, showClosedIssues]);

  const visibleIdeas = useMemo(() => {
    return pendingIdea ? mergeIdeas([pendingIdea, ...ideas]) : ideas;
  }, [ideas, pendingIdea]);

  const selectedIdea = useMemo(() => {
    return visibleIdeas.find((idea) => idea.id === selectedIdeaId);
  }, [selectedIdeaId, visibleIdeas]);

  useEffect(() => {
    if (selectedIdeaId && visibleIdeas.some((idea) => idea.id === selectedIdeaId)) {
      return;
    }

    setSelectedIdeaId(visibleIdeas[0]?.id ?? '');
  }, [selectedIdeaId, visibleIdeas]);

  useEffect(() => {
    setDraftValues(toEditableIdeaValues(selectedIdea));
    setIsDirty(false);
  }, [selectedIdea?.id, selectedIdea?.updatedAt, selectedIdea?.source]);

  async function createIdea() {
    const now = new Date().toISOString();
    const nextIdea: IdeaPresentationRecord = {
      body: '',
      createdAt: now,
      id: crypto.randomUUID(),
      iteration: '',
      qualityGate: {
        hasDescription: false,
        hasIteration: false,
        hasTitle: false,
        isReady: false
      },
      source: 'local',
      title: '',
      updatedAt: now
    };

    setPendingIdea(nextIdea);
    setSelectedIdeaId(nextIdea.id);
    setSyncErrors((current) => {
      const next = { ...current };
      delete next[nextIdea.id];
      return next;
    });
    setDraftValues(toEditableIdeaValues(nextIdea));
    setIsDirty(false);
  }

  async function saveIdea() {
    if (!project || !selectedIdea) {
      return;
    }

    setIsSaving(true);
    setLoadError('');

    const nextIdea = applyIdeaValues(selectedIdea, draftValues);
    const isPendingIdea = pendingIdea?.id === nextIdea.id;

    try {
      if (nextIdea.source === 'local') {
        const persistLocalIdea = async () => {
          const savedDraft = await window.projectSpace.saveLocalIdeaDraft({
            draft: toLocalIdeaDraft(nextIdea),
            projectPath: project.rootPath
          });
          const savedPresentation = toIdeaPresentationRecord(savedDraft);

          setPendingIdea(undefined);
          setIdeas((current) =>
            mergeIdeas([
              savedPresentation,
              ...current.filter((entry) => entry.id !== savedPresentation.id)
            ])
          );
          setSelectedIdeaId(savedPresentation.id);
          setDraftValues(toEditableIdeaValues(savedPresentation));
          setIsDirty(false);

          return savedPresentation;
        };

        if (!nextIdea.title.trim()) {
          const savedPresentation = await persistLocalIdea();

          setSyncErrors((current) => {
            const next = { ...current };
            delete next[savedPresentation.id];
            return next;
          });
          return;
        }

        if (issueSourceConfig.kind !== 'github') {
          const savedPresentation = await persistLocalIdea();

          setSyncErrors((current) => ({
            ...current,
            [savedPresentation.id]:
              issueSourceConfig.kind === 'azure-devops'
                ? 'Azure DevOps issue publishing is not implemented yet.'
                : 'Configure an issue source in project settings before publishing titled ideas.'
          }));
          return;
        }

        const publishResult = await window.projectSpace.createGithubIdeaFromDraft({
          draft: toLocalIdeaDraft(nextIdea),
          projectPath: project.rootPath
        });

        if (publishResult.status === 'error') {
          const savedPresentation = await persistLocalIdea();

          setSyncErrors((current) => ({
            ...current,
            [savedPresentation.id]: publishResult.message
          }));
          return;
        }

        const publishedIdea = toIdeaPresentationRecord(publishResult.idea);

        setPendingIdea(undefined);
        if (!isPendingIdea) {
          await window.projectSpace.deleteLocalIdeaDraft({
            ideaId: nextIdea.id,
            projectPath: project.rootPath
          });
        }
        setIdeas((current) =>
          mergeIdeas([
            publishedIdea,
            ...current.filter((entry) => entry.id !== publishedIdea.id)
          ])
        );
        setSelectedIdeaId(publishedIdea.id);
        setSyncErrors((current) => {
          const next = { ...current };
          delete next[publishedIdea.id];
          return next;
        });
        setDraftValues(toEditableIdeaValues(publishedIdea));
        setIsDirty(false);
        return;
      }

      if (issueSourceConfig.kind !== 'github') {
        setSyncErrors((current) => ({
          ...current,
          [nextIdea.id]:
            issueSourceConfig.kind === 'azure-devops'
              ? 'Azure DevOps issue sync is not implemented yet.'
              : 'Configure an issue source in project settings before saving published ideas.'
        }));
        return;
      }

      const updateResult = await window.projectSpace.updateGithubIdea({
        idea: toGithubIdea(nextIdea),
        projectPath: project.rootPath
      });

      if (updateResult.status === 'error') {
        setSyncErrors((current) => ({
          ...current,
          [nextIdea.id]: updateResult.message
        }));
        return;
      }

      const updatedIdea = toIdeaPresentationRecord(updateResult.idea);

      setIdeas((current) =>
        mergeIdeas([
          updatedIdea,
          ...current.filter((entry) => entry.id !== updatedIdea.id)
        ])
      );
      setSelectedIdeaId(updatedIdea.id);
      setSyncErrors((current) => {
        const next = { ...current };
        delete next[updatedIdea.id];
        return next;
      });
      setDraftValues(toEditableIdeaValues(updatedIdea));
      setIsDirty(false);
    } catch (error) {
      setSyncErrors((current) => ({
        ...current,
        [nextIdea.id]: error instanceof Error ? error.message : 'Could not save the idea.'
      }));
    } finally {
      setIsSaving(false);
    }
  }

  return {
    createIdea,
    draftValues,
    ideas: visibleIdeas,
    isDirty,
    isLoading,
    isSaving,
    loadError,
    selectedIdea,
    selectedIdeaId,
    saveIdea,
    showClosedIssues,
    syncErrors,
    setDraftValue<Key extends keyof EditableIdeaValues>(key: Key, value: EditableIdeaValues[Key]) {
      setDraftValues((current) => ({
        ...current,
        [key]: value
      }));
      setIsDirty(true);
    },
    setSelectedIdeaId,
    setShowClosedIssues
  };
}
