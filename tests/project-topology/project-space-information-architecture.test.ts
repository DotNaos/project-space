import { describe, expect, test } from 'bun:test';
import {
  defaultProjectHomeView,
  projectChatBreadcrumbs,
  projectSpacePrimaryNavigation,
  projectSpaceViewPlacement
} from '../../src/features/project-topology/project-space-information-architecture';

describe('Project Space information architecture', () => {
  test('keeps the primary navigation focused on destinations, not implementation layers', () => {
    expect(projectSpacePrimaryNavigation).toEqual([
      { destination: 'home', label: 'Home' },
      { destination: 'chat', label: 'Chat' },
      { destination: 'projects', label: 'Projects' }
    ]);
    expect(defaultProjectHomeView).toBe('summary');
  });

  test('folds the old topology and Codex destinations into Home and Chat', () => {
    expect(projectSpaceViewPlacement('topology')).toEqual({
      destination: 'home',
      view: 'map'
    });
    expect(projectSpaceViewPlacement('root')).toEqual({
      destination: 'home',
      view: 'summary'
    });
    expect(projectSpaceViewPlacement('codex')).toEqual({
      destination: 'chat',
      layer: 'agent'
    });
    expect(projectSpaceViewPlacement('machines')).toEqual({
      context: 'machines',
      destination: 'projects'
    });
  });

  test('expresses Lead, Project Lead, and agent chats as one ordered hierarchy', () => {
    const target = {
      kind: 'agent' as const,
      projectId: 'project-space',
      projectLabel: 'Project Space',
      taskId: 'issue-177',
      taskLabel: '#177 · Fayn-EVT6AF'
    };

    expect(projectChatBreadcrumbs(target).map((crumb) => crumb.label)).toEqual([
      'Lead',
      'Project Space',
      '#177 · Fayn-EVT6AF'
    ]);
    expect(projectChatBreadcrumbs(target)[1]?.target).toEqual({
      kind: 'project-lead',
      projectId: 'project-space',
      projectLabel: 'Project Space'
    });
  });
});
