import { useState } from 'react';

import type { Feature, Project, Sprint } from '@/domain';
import { mockProject } from '../mocks/mock-project';

type Selection =
  | { type: 'project'; id: string }
  | { type: 'sprint'; id: string }
  | { type: 'feature'; id: string }
  | { type: 'task'; id: string };

function findProject(projectId: string) {
  return projectId === mockProject.id ? mockProject : mockProject;
}

function findSprint(project: Project, sprintId: string | undefined) {
  return project.sprints.find((sprint) => sprint.id === sprintId) ?? project.sprints[0];
}

function findFeature(sprint: Sprint | undefined, featureId: string | undefined) {
  return sprint?.features.find((feature) => feature.id === featureId) ?? sprint?.features[0];
}

function findTask(feature: Feature | undefined, taskId: string | undefined) {
  return feature?.tasks.find((task) => task.id === taskId) ?? feature?.tasks[0];
}

function deriveSelectedTask(project: Project, selection: Selection) {
  if (selection.type === 'task') {
    for (const sprint of project.sprints) {
      for (const feature of sprint.features) {
        const task = feature.tasks.find((item) => item.id === selection.id);
        if (task) {
          return { sprint, feature, task };
        }
      }
    }
  }

  if (selection.type === 'feature') {
    for (const sprint of project.sprints) {
      const feature = sprint.features.find((item) => item.id === selection.id);
      if (feature) {
        return { sprint, feature, task: feature.tasks[0] };
      }
    }
  }

  if (selection.type === 'sprint') {
    const sprint = findSprint(project, selection.id);
    const feature = findFeature(sprint, undefined);
    const task = findTask(feature, undefined);
    return { sprint, feature, task };
  }

  const sprint = findSprint(project, undefined);
  const feature = findFeature(sprint, undefined);
  const task = findTask(feature, undefined);
  return { sprint, feature, task };
}

function selectionPath(project: Project, sprint?: Sprint, feature?: Feature, task?: { name: string }) {
  return [project.name, sprint?.name, feature?.name, task?.name].filter(Boolean).join(' / ');
}

export function useProjectDesktop() {
  const [selection, setSelection] = useState<Selection>({
    type: 'task',
    id: 'task-minimum-shell'
  });
  const [activeSelection, setActiveSelection] = useState('Nothing selected yet.');

  const project = findProject(mockProject.id);
  const selectedContext = deriveSelectedTask(project, selection);
  const sprint = selectedContext.sprint;
  const feature = selectedContext.feature;
  const task = selectedContext.task;
  const selectedPath = selectionPath(project, sprint, feature, task);

  return {
    project,
    selection,
    selectedPath,
    activeSelection,
    hasPendingSelection: activeSelection !== selectedPath,
    confirmSelection() {
      setActiveSelection(selectedPath);
    },
    selectNode(selectionType: Selection['type'], id: string) {
      setSelection({ type: selectionType, id });
    }
  };
}
