import { useEffect, useState } from 'react';

export interface ProjectSpaceRecord {
  id: string;
  name: string;
  rootPath: string;
}

const STORAGE_KEY = 'project-space.projects';

function makeProjectId(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function useProjectDesktop() {
  const [projects, setProjects] = useState<ProjectSpaceRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');

  useEffect(() => {
    try {
      const storedValue = window.localStorage.getItem(STORAGE_KEY);
      if (!storedValue) {
        return;
      }

      const parsed = JSON.parse(storedValue) as ProjectSpaceRecord[];
      setProjects(parsed);
      setSelectedProjectId(parsed[0]?.id ?? '');
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  }, [projects]);

  const project = projects.find((entry) => entry.id === selectedProjectId) ?? projects[0];

  async function createProject() {
    const selection = await window.projectSpace.selectProjectDirectory();
    if (selection.canceled || !selection.path || !selection.name) {
      return;
    }

    const baseId = makeProjectId(selection.name);
    const nextId = projects.some((projectItem) => projectItem.id === baseId)
      ? `${baseId}-${projects.length + 1}`
      : baseId;

    const nextProject = {
      id: nextId,
      name: selection.name.trim(),
      rootPath: selection.path.trim()
    };

    setProjects((current) => [...current, nextProject]);
    setSelectedProjectId(nextProject.id);
  }

  return {
    projects,
    project,
    selectedProjectPath: project?.rootPath ?? 'No project selected.',
    createProject,
    selectProject(projectId: string) {
      setSelectedProjectId(projectId);
    }
  };
}
