import type { Project } from '@/domain';

export const mockProject: Project = {
  id: 'project-space',
  name: 'project-space',
  slug: 'project-space',
  rootPath: '/Users/oli/projects/project-space/project-space',
  summary:
    'Desktop-first workspace for running a project through iteration, feature, task, and worktree context.',
  currentIteration: 1,
  sprints: [
    {
      id: 'sprint-mvp',
      name: 'Sprint 01',
      goal: 'Define the first real MVP cut and reduce the UI to a single-project shell.',
      status: 'active',
      features: [
        {
          id: 'feature-mvp-shell',
          name: 'Minimal project desktop',
          summary:
            'Keep the workflow explorer, selected task context, worktree context, and launcher placeholders.',
          status: 'active',
          tasks: [
            {
              id: 'task-project-vision',
              name: 'Write product vision',
              summary:
                'Capture the product thesis, the hierarchy, and the deliberate MVP cut in repo docs.',
              status: 'active',
              worktrees: [
                {
                  id: 'worktree-mvp-foundation',
                  name: 'mvp-foundation',
                  branchName: 'iteration/1/mvp-foundation',
                  iterationBranchName: 'iteration/1',
                  rootPath: '/Users/oli/projects/project-space/project-space',
                  status: 'active',
                  issueDocuments: [
                    {
                      id: 'issue-mvp-vision',
                      title: 'Issue.md',
                      path: '.dev/issues/mvp-foundation.md',
                      summary:
                        'Tracks the reduced MVP and the current thinking for the first usable project desktop.',
                      status: 'active',
                      checklist: [
                        {
                          id: 'check-vision-1',
                          label: 'Describe what project-space is',
                          done: true
                        },
                        {
                          id: 'check-vision-2',
                          label: 'Describe what the MVP is not',
                          done: true
                        },
                        {
                          id: 'check-vision-3',
                          label: 'Reduce the desktop UI',
                          done: false
                        }
                      ]
                    }
                  ]
                }
              ]
            },
            {
              id: 'task-minimum-shell',
              name: 'Reduce renderer shell',
              summary:
                'Keep one project, one workflow tree, one selected task view, and launcher placeholders.',
              status: 'active',
              worktrees: [
                {
                  id: 'worktree-minimum-shell',
                  name: 'minimum-shell',
                  branchName: 'iteration/1/minimum-shell',
                  iterationBranchName: 'iteration/1',
                  rootPath: '/Users/oli/projects/project-space/project-space',
                  status: 'active',
                  issueDocuments: [
                    {
                      id: 'issue-minimum-shell',
                      title: 'Issue.md',
                      path: '.dev/issues/minimum-shell.md',
                      summary:
                        'Placeholder issue document for the simplified desktop shell.',
                      status: 'draft',
                      checklist: [
                        {
                          id: 'check-shell-1',
                          label: 'Remove fake multi-project UI',
                          done: true
                        },
                        {
                          id: 'check-shell-2',
                          label: 'Keep worktree context visible',
                          done: true
                        },
                        {
                          id: 'check-shell-3',
                          label: 'Keep launcher actions as placeholders',
                          done: true
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  ]
};
