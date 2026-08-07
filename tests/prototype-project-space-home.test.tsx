import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ProjectSpaceHome,
  projectFixtures,
  projectSpaceCanvasBackground,
  projectSpaceShellBackground
} from '../apps/prototype/src/project-space-home';
import {
  ProjectFeaturePage,
  ProjectIssueDetailPage,
  ProjectTaskDetailPage,
  initialMockTasks,
  mockTaskNeedsAttention,
  mockTaskWorkflowState,
  prototypeIssueByNumber,
  updateMockTask
} from '../apps/prototype/src/project-space-pages';
import {
  ProjectSidebar,
  projectPageGroups
} from '../apps/prototype/src/project-space-sidebar';
import {
  prototypeIssueColumns,
  prototypeIssues,
} from '../apps/prototype/src/project-space-pages/issue-fixtures';
import { filterAndSortPrototypeIssues, ProjectIssuesPage } from '../apps/prototype/src/project-space-pages/issues';
import { BranchDetailView } from '../apps/prototype/src/project-space-pages/branch-detail';
import { prototypeBranches } from '../apps/prototype/src/project-space-pages/branch-fixtures';
import { filterPrototypeBranches } from '../apps/prototype/src/project-space-pages/branches-and-workspaces';
import { ProjectTemplateCheck } from '../apps/prototype/src/project-space-pages/template-check';
import { projectTemplateCheckSummary } from '../apps/prototype/src/project-space-pages/template-contract';
import {
  projectChatAgentEntries,
  projectChatMachineCounts,
} from '../apps/prototype/src/project-space-pages/project-chat-model';
import { TaskDevelopmentServerFrame } from '../apps/prototype/src/project-space-pages/task-development-server-frame';
import { createMockTask } from '../apps/prototype/src/project-space-pages/task-model';

describe('project space home prototype', () => {
  test('embeds the local development server fixture in a real iframe', () => {
    const task = initialMockTasks.find((candidate) => candidate.number === 395)!;
    const html = renderToStaticMarkup(<TaskDevelopmentServerFrame task={task} />);

    expect(html).toContain('<iframe');
    expect(html).toContain('title="Test development server"');
    expect(html).toContain('/prototype/desktop/dev-server-mock.html?');
    expect(html).toContain('issue=395');
    expect(html).toContain('machine=os-pc');
  });

  test('uses one shell surface behind the sidebar and rounded main view', () => {
    expect(projectSpaceShellBackground('dark')).toBe('#151515');
    expect(projectSpaceShellBackground('light')).toBe('#efeee9');
    expect(projectSpaceCanvasBackground('dark')).toBe('#0a0a0a');
    expect(projectSpaceCanvasBackground('light')).toBe('#f7f5f0');
    expect(projectFixtures).toHaveLength(10);
    expect(projectFixtures.some((project) => project.name === 'prototype-lab')).toBe(true);
  });

  test('keeps project context, workflow navigation, account, and idea composer together', () => {
    const html = renderToStaticMarkup(
      <ProjectSpaceHome scenario="ready" theme="dark" />
    );

    expect(html).toContain('data-testid="project-space-home"');
    expect(html).toContain('data-testid="mobile-main-card"');
    expect(html).toContain('data-testid="project-selector-trigger"');
    expect(html).toContain('data-testid="sidebar-account-bar"');
    expect(html).toContain('mb-3 shrink-0');
    expect(html).not.toContain('data-testid="sidebar-account-podium"');
    expect(html).toContain('aria-label="Project sidebar"');
    expect(html).toContain('hidden shrink-0 overflow-hidden');
    expect(html).toContain('@3xl:block w-72');
    expect(html).toContain('aria-label="Switch project, current project project-space"');
    expect(html).not.toContain('before:absolute');
    expect(html).toContain('project-space');
    expect(html).toContain('>Tasks<');
    expect(html).toContain('>Repository<');
    expect(html).toContain('>Machines<');
    expect(html).toContain('>Chat<');
    expect(html).not.toContain('>Workspaces<');
    expect(html).not.toContain('>History<');
    expect(html).not.toContain('>Codex<');
    expect(html).toContain('>Templates<');
    expect(html).not.toContain('>Overview<');
    expect(html).not.toContain('>Deployments<');
    expect(html).toContain('>Oli<');
    expect(html).toContain('placeholder="Describe a feature, bug, or idea"');
    expect(html).toContain('Nothing external will change.');
    expect(html).not.toContain('#437 · Redesign the Project Space frontend');
  });

  test('keeps the same navigation in the empty preview', () => {
    const html = renderToStaticMarkup(
      <ProjectSpaceHome scenario="empty" theme="light" />
    );

    expect(html).toContain('>Tasks<');
    expect(html).toContain('>Templates<');
    expect(html).toContain('bg-[#f8f7f3]');
  });

  test('renders each navigation target as a distinct main page', () => {
    const html = renderToStaticMarkup(
      <ProjectFeaturePage
        page="machines"
        projectName="project-space"
        scenario="ready"
      />
    );

    expect(html).toContain('<h1');
    expect(html).toContain('Machines</h1>');
    expect(html).toContain('os-pc');
    expect(html).not.toContain('Redesign the Project Space frontend');
  });

  test.each([
    ['overview', 'Current focus', 'Project pulse'],
    ['issues', 'Search tasks', 'Backlog'],
    ['branches', 'Search branches, PRs, or machines', '30 of 30 branches'],
    ['machines', 'Available destinations', 'os-pc'],
    ['chats', 'Project manager', 'Agent runs'],
    ['template', 'Project Template', 'Required pipelines'],
    ['deployments', 'Pull request previews', 'Production'],
  ] as const)('gives the %s page its own working surface', (page, first, second) => {
    const html = renderToStaticMarkup(
      <ProjectFeaturePage
        page={page}
        projectName="project-space"
        scenario="ready"
      />
    );

    expect(html).toContain(first);
    expect(html).toContain(second);
  });

  test('keeps the project manager and every Agent run in one machine-aware timeline', () => {
    const entries = projectChatAgentEntries(initialMockTasks);
    const machineCounts = projectChatMachineCounts(entries);
    const html = renderToStaticMarkup(
      <ProjectFeaturePage
        page="chats"
        projectName="project-space"
        scenario="ready"
        tasks={initialMockTasks}
      />
    );

    expect(entries.map((entry) => entry.actor)).toEqual(['Aurora', 'Calypso', 'Nora', 'Juno', 'Mira']);
    expect(machineCounts).toEqual([
      { count: 3, machine: 'Local' },
      { count: 1, machine: 'os-pc' },
      { count: 1, machine: 'os-yoga-unix' },
    ]);
    expect(html).toContain('Select project manager machine');
    expect(html).toContain('Persistent project thread · main worktree');
    expect(html).toContain('Aurora');
    expect(html).toContain('Calypso');
    expect(html).toContain('Nora');
    expect(html).toContain('Juno');
    expect(html).toContain('Mira');
    expect(html).toContain('Task #437');
    expect(html).toContain('Issue #437');
    expect(html).toContain('placeholder="Message the project"');
    expect(html).not.toContain('Search conversations');
    expect(html).not.toContain('New chat');
  });

  test('keeps branch search thumb-reachable and gives filters icons', () => {
    const html = renderToStaticMarkup(
      <ProjectFeaturePage
        page="branches"
        projectName="project-space"
        scenario="ready"
      />
    );

    expect(html).toContain('lucide-list-filter');
    expect(html).toContain('lucide-git-pull-request');
    expect(html).toContain('lucide-laptop');
    expect(html).toContain('lucide-triangle-alert');
    expect(html).toContain('border-t border-current/[.08] py-3 @3xl:hidden');
    expect(html).not.toContain('No PR');
    expect(html).not.toContain('Not checked out');
  });

  test('renders every task lifecycle state and treats errors as an overlay', () => {
    const html = renderToStaticMarkup(
      <ProjectFeaturePage
        page="issues"
        projectName="project-space"
        scenario="ready"
        tasks={initialMockTasks}
      />
    );

    expect(mockTaskWorkflowState(initialMockTasks.find((task) => task.number === 437)!)).toBe('Backlog');
    expect(mockTaskWorkflowState(initialMockTasks.find((task) => task.number === 426)!)).toBe('Active');
    expect(mockTaskWorkflowState(initialMockTasks.find((task) => task.number === 398)!)).toBe('Review');
    expect(mockTaskWorkflowState(initialMockTasks.find((task) => task.number === 395)!)).toBe('Review');
    expect(mockTaskWorkflowState(initialMockTasks.find((task) => task.number === 434)!)).toBe('Completed');
    expect(mockTaskNeedsAttention(initialMockTasks.find((task) => task.number === 398)!)).toBe(true);
    expect(mockTaskNeedsAttention(initialMockTasks.find((task) => task.number === 395)!)).toBe(false);
    expect(html).toContain('>All<');
    expect(html).toContain('>Backlog<');
    expect(html).toContain('>Active<');
    expect(html).toContain('>Review<');
    expect(html).toContain('>Completed<');
    expect(html).toContain('aria-labelledby="task-section-backlog"');
    expect(html).toContain('aria-labelledby="task-section-active"');
    expect(html).toContain('aria-labelledby="task-section-review"');
    expect(html).toContain('aria-labelledby="task-section-completed"');
    expect(html).toContain('#437');
    expect(html).toContain('#398');
    expect(html).toContain('#434');
    expect(html).toContain('aria-label="Backlog"');
    expect(html).toContain('aria-label="Active"');
    expect(html).toContain('aria-label="Review"');
    expect(html).toContain('aria-label="Error"');
    expect(html).toContain('aria-label="Completed"');
    expect(html).toContain('aria-label="Open pull request #420"');
    expect(html).toContain('aria-label="Draft pull request #427"');
    expect(html).toContain('aria-label="Merged pull request #435"');
    expect(html).toContain('bg-emerald-500/[.12]');
    expect(html).toContain('bg-violet-500/[.12]');
    expect(html).not.toContain('>Bug<');
    expect(html).not.toContain('>Feature<');
    expect(html).not.toContain('aria-label="Task view"');
    expect(html).not.toContain('>History<');
    expect(html).not.toContain('>Blocked<');
  });

  test('renders draft pull requests as neutral chips', () => {
    const draftTask = {
      ...initialMockTasks.find((task) => task.number === 398)!,
      pullRequest: {
        ...initialMockTasks.find((task) => task.number === 398)!.pullRequest!,
        phase: 'draft' as const,
      },
    };
    const html = renderToStaticMarkup(
      <ProjectFeaturePage
        page="issues"
        projectName="project-space"
        scenario="ready"
        tasks={[draftTask]}
      />
    );

    expect(html).toContain('aria-label="Draft pull request #420"');
    expect(html).toContain('bg-current/[.055]');
  });

  test('keeps realistic branch volume searchable and filterable', () => {
    expect(prototypeBranches).toHaveLength(30);
    expect(prototypeBranches.some((branch) => branch.name === 'issue-437-redesign-the-project-space-frontend')).toBe(true);
    expect(filterPrototypeBranches({ branches: prototypeBranches, filter: 'Pull request', query: '' }).every((branch) => branch.pullRequest)).toBe(true);
    expect(filterPrototypeBranches({ branches: prototypeBranches, filter: 'Checked out', query: '' }).every((branch) => branch.workspaces.length > 0)).toBe(true);
    expect(filterPrototypeBranches({ branches: prototypeBranches, filter: 'All', query: 'os-pc' }).every((branch) => branch.workspaces.some((workspace) => workspace.machine === 'os-pc'))).toBe(true);
  });

  test('checks a selected Repository branch against the Project Template', () => {
    const mainSummary = projectTemplateCheckSummary('main');
    const issueSummary = projectTemplateCheckSummary('issue-437-redesign-the-project-space-frontend');
    const html = renderToStaticMarkup(
      <ProjectTemplateCheck
        branches={['main', 'issue-437-redesign-the-project-space-frontend']}
        selectedBranch="issue-437-redesign-the-project-space-frontend"
        onBranchChange={() => undefined}
      />
    );

    expect(mainSummary).toEqual({ total: 16, valid: 16 });
    expect(issueSummary).toEqual({ total: 16, valid: 15 });
    expect(html).toContain('Project Template check');
    expect(html).toContain('Select branch for Template check');
    expect(html).toContain('Needs attention');
    expect(html).toContain('Signed release');
  });

  test('combines branch history, pull requests, and machine workspaces in one detail view', () => {
    const branch = prototypeBranches.find((candidate) => candidate.name.includes('437'))!;
    const html = renderToStaticMarkup(<BranchDetailView branch={branch} onBack={() => undefined} />);

    expect(html).toContain('>History<');
    expect(html).toContain('Machine workspaces');
    expect(html).toContain('Local');
    expect(html).toContain('os-pc');
    expect(html).toContain('os-yoga-unix');
    expect(html).toContain('aria-label="Open workspace on Local"');
    expect(html).toContain('aria-label="Open changes on Local"');
    expect(html).toContain('aria-label="Check out branch on os-yoga-unix"');
    expect(html).not.toContain('Not checked out');
    expect(html).toContain('No pull request');
    expect(html).not.toContain('Worktree ready');
    expect(html).not.toContain('3 changed files');
    expect(html).not.toContain('Git status available');
    expect(html).toContain('grid w-full grid-cols-2 gap-2');
  });

  test('offers board and list views that open the same issues', () => {
    const board = renderToStaticMarkup(
      <ProjectIssuesPage
        onOpenIssue={() => undefined}
        onViewModeChange={() => undefined}
        projectName="project-space"
        scenario="ready"
        viewMode="board"
      />
    );
    const list = renderToStaticMarkup(
      <ProjectIssuesPage
        onOpenIssue={() => undefined}
        onViewModeChange={() => undefined}
        projectName="project-space"
        scenario="ready"
        viewMode="list"
      />
    );

    expect(board).toContain('aria-label="Issue board"');
    expect(board).toContain('data-scroll-region="issue-board-horizontal"');
    expect(board.match(/data-scroll-region="issue-column"/g)).toHaveLength(3);
    expect(board).toContain('Backlog');
    expect(board).toContain('In progress');
    expect(board).toContain('Done');
    expect(board).not.toContain('>Ready<');
    expect(board).not.toContain('>Blocked<');
    expect(board).toContain('Open issue #437 on GitHub');
    expect(board).toContain('Open branch issue-437-redesign-the-project-space-frontend on GitHub');
    expect(board).toContain('Open pull request #420 on GitHub');
    expect(board).toContain('>#435<');
    expect(board).not.toContain('#435 · Merged');
    expect(board).not.toContain('Updated now');
    expect(board).not.toContain('Plan, track, and finish work without losing its delivery context.');
    expect(board).not.toContain('uppercase');
    expect(list).not.toContain('aria-label="Issue board"');
    expect(list).toContain('aria-label="Issue table"');
    expect(list).toContain('Filter by label');
    expect(list).toContain('Filter by development');
    expect(list).toContain('Development');
    expect(list).toContain('Open issue #437');
  });

  test('combines issue table filters and sorting', () => {
    const filtered = filterAndSortPrototypeIssues({
      development: 'Pull request',
      issues: prototypeIssues,
      label: 'ci',
      sortDescriptor: { column: 'issue', direction: 'ascending' },
    });

    expect(filtered.map((issue) => issue.number)).toEqual([419, 434]);
    expect(filterAndSortPrototypeIssues({
      development: 'All',
      issues: prototypeIssues,
      label: 'All',
      sortDescriptor: { column: 'updated', direction: 'descending' },
    }).map((issue) => issue.number)).toEqual([437, 426, 434, 419, 408, 398, 395]);
  });

  test('derives board progression from pull request state', () => {
    expect(prototypeIssueColumns.map((column) => column.id)).toEqual([
      'Backlog',
      'In progress',
      'Done',
    ]);
    expect(prototypeIssues.filter((issue) => issue.column === 'Backlog').every((issue) => !issue.pullRequest)).toBe(true);
    expect(prototypeIssues.filter((issue) => issue.column === 'In progress').every((issue) => issue.pullRequest?.state === 'Open')).toBe(true);
    expect(prototypeIssues.filter((issue) => issue.column === 'Done').every((issue) => issue.pullRequest?.state === 'Merged')).toBe(true);
  });

  test('renders an issue as a complete workflow detail view', () => {
    const issue = prototypeIssueByNumber(437);
    expect(issue).toBeDefined();
    const html = renderToStaticMarkup(
      <ProjectIssueDetailPage
        issue={issue!}
        onBack={() => undefined}
        projectName="project-space"
      />
    );

    expect(html).toContain('#437');
    expect(html).toContain('Open on GitHub');
    expect(html).toContain('Edit issue');
    expect(html).toContain('href="https://github.com/DotNaos/project-space/issues/437"');
    expect(html).toContain('>Issue</h2>');
    expect(html).toContain('Acceptance criteria');
    expect(html).toContain('Development workflow');
    expect(html).toContain('issue-437-redesign-the-project-space-frontend');
    expect(html).toContain('Create PR');
    expect(html).toContain('commented yesterday');
    expect(html).toContain('Use Markdown to format your comment');
    expect(html).toContain('Preview deployment');
    expect(html).toContain('Run tests');
    expect(html).toContain('Details');
    expect(html).toContain('Add a comment');
    expect(html).toContain('Comment</button>');
    expect(html).toContain('Delivery state');
  });

  test('guides a task with one next action and secondary development details', () => {
    const task = initialMockTasks.find((candidate) => candidate.number === 437)!;
    const html = renderToStaticMarkup(
      <ProjectTaskDetailPage
        onAction={() => undefined}
        onBack={() => undefined}
        projectName="project-space"
        task={task}
      />
    );

    expect(html).toContain('#437');
    expect(html).not.toContain('aria-label="Task lifecycle"');
    expect(html).not.toContain('>Lifecycle<');
    expect(html).toContain('Planning');
    expect(html).toContain('Codex is implementing the selected prototype direction.');
    expect(html).toContain('Finish setup');
    expect(html).toContain('data-testid="task-mobile-primary-action"');
    expect(html).toContain('Working context');
    expect(html).toContain('Development details');
    expect(html).toContain('Agent run · Local');
    expect(html).toContain('GitHub issue');
    expect(html).toContain('Discussion');
    expect(html).toContain('Activity history');
    expect(html).toContain('Add Task comment');
  });

  test('keeps the start-development action reachable on narrow task layouts', () => {
    const task = createMockTask({
      body: 'Create a linked branch and draft pull request.',
      labels: [],
      number: 494,
      title: 'Start development safely',
      type: 'Bug'
    });
    const html = renderToStaticMarkup(
      <ProjectTaskDetailPage
        onAction={() => undefined}
        onBack={() => undefined}
        projectName="project-space"
        task={task}
      />
    );

    expect(html).toContain('data-testid="task-mobile-primary-action"');
    expect(html).toContain('Start development');
  });

  test('shows delivery first and reveals execution context when a task needs attention', () => {
    const task = initialMockTasks.find((candidate) => candidate.number === 398)!;
    const html = renderToStaticMarkup(
      <ProjectTaskDetailPage
        onAction={() => undefined}
        onBack={() => undefined}
        projectName="project-space"
        task={task}
      />
    );

    expect(html).toContain('PR deployment');
    expect(html).toContain('Not ready');
    expect(html).toContain('aria-label="Error"');
    expect(html).toContain('Pull request');
    expect(html).toContain('href="https://github.com/DotNaos/project-space/pull/420"');
    expect(html).toContain('Pipeline');
    expect(html).toContain('Checks failed');
    expect(html).toContain('Retry checks');
    expect(html).toContain('Working context');
    expect(html).toContain('os-pc');
    expect(html).toContain('#398 · Verify delivery evidence · running');
    expect(html).toContain('3 files changed');
  });

  test('uses the task status icon in the started task detail header', () => {
    const task = initialMockTasks.find((candidate) => candidate.number === 426)!;
    const html = renderToStaticMarkup(
      <ProjectTaskDetailPage
        onAction={() => undefined}
        onBack={() => undefined}
        projectName="project-space"
        task={task}
      />
    );

    expect(html).toContain('aria-label="Active"');
    expect(html).toContain('lucide-circle-dot');
    expect(html).not.toContain('>Active<');
    expect(html).not.toContain('>Feature<');
    expect(html).toContain('lucide-git-pull-request-draft');
    expect(html).toContain('Draft #427');
    expect(html).toContain('First version ready');
    expect(html).toContain('data-testid="task-mobile-primary-action"');
    expect(html).toContain('data-testid="task-panel-primary-action"');
    expect(html).toContain('hidden flex-wrap gap-2 @3xl:flex');
    expect(html).not.toContain('Waiting for checks');
    expect(html).not.toContain('>Pipeline<');
    expect(html).not.toContain('Development details');
    expect(html).not.toContain('project-space · opened by');
    expect(html).not.toContain('lucide-file-text');
    expect(html).not.toContain('>Description</h2>');
    expect(html).toContain('Add an on-demand PR Preview hub</span></h1><p');
    expect(html).toContain('>#426</p>');
    expect(html).not.toContain('size-1.5 rounded-full bg-current');

    const inProgressTask = updateMockTask(task, { type: 'mark-pull-request-ready' });
    const inProgressHtml = renderToStaticMarkup(
      <ProjectTaskDetailPage
        onAction={() => undefined}
        onBack={() => undefined}
        projectName="project-space"
        task={inProgressTask}
      />
    );
    expect(mockTaskWorkflowState(inProgressTask)).toBe('Review');
    expect(inProgressHtml).not.toContain('data-testid="task-mobile-primary-action"');
    expect(inProgressHtml).toContain('Pipeline');
    expect(inProgressHtml).toContain('Pass checks');
  });

  test('keeps a healthy task focused on its Preview and pull request', () => {
    const task = initialMockTasks.find((candidate) => candidate.number === 395)!;
    const html = renderToStaticMarkup(
      <ProjectTaskDetailPage
        onAction={() => undefined}
        onBack={() => undefined}
        projectName="project-space"
        task={task}
      />
    );

    expect(html).not.toContain('Ready to view');
    expect(html).toContain('PR deployment');
    expect(html).toContain('data-testid="pr-deployment-surface"');
    expect(html).toContain('data-testid="dev-server-bundle"');
    expect(html).toContain('Design Space');
    expect(html).toContain('href="http://design-space.localhost:1355/"');
    expect(html).toContain('Open Prototype from Dev server');
    expect(html).toContain('Open Design Space from Dev server');
    expect(html).not.toContain('aria-label="Prototype · Online"');
    expect(html).not.toContain('aria-label="Design Space · Online"');
    expect(html).toContain('#404');
    expect(html).toContain('Checks passed');
    expect(html).toContain('Active development');
    expect(html).toContain('os-pc');
    expect(html).toContain('aria-label="Add machine"');
    expect(html).not.toContain('Tailscale · Clean');
    expect(html).toContain('Connected');
    expect(html).toContain('data-testid="task-mobile-primary-action"');
    expect(html).toContain('hidden flex-wrap gap-2 @3xl:flex');
    expect(html).toContain('#395</p><p');
    expect(html).toContain('Require verified live iteration for prototypes');
    expect(html).toContain('aria-label="os-pc active development"');
    expect(html).toContain('Dev server');
    expect(html).toContain('Live');
    expect(html).toContain('Codex threads');
    expect(html).toContain('Open #395 · Secure prototype on os-pc');
    expect(html).toContain('Open Verify mobile Preview on os-macbook');
    expect(html).not.toContain('>Development<');
    expect(html).not.toContain('>Continue<');
    expect(html).not.toContain('Request review');
    expect(html).not.toContain('Working context');
  });

  test('shows branch cleanup and a single delete action for closed tasks', () => {
    const task = initialMockTasks.find((candidate) => candidate.number === 434)!;
    const html = renderToStaticMarkup(
      <ProjectTaskDetailPage
        onAction={() => undefined}
        onBack={() => undefined}
        projectName="project-space"
        task={task}
      />
    );

    expect(html).toContain('data-testid="closed-task-checkouts"');
    expect(html).toContain('Branch checkouts');
    expect(html).toContain('On GitHub · Safe to delete');
    expect(html).toContain('issue-434-make-agent-authored-pr-revisions-green-on-first-push');
    expect(html).toContain('Merged #435');
    expect(html).toContain('lucide-git-merge');
    expect(html).toContain('os-pc');
    expect(html).toContain('Local checkout · Clean · Safe to delete');
    expect(html).toContain('No local changes');
    expect(html).toContain('os-macbook');
    expect(html).toContain('Local checkout · 3 uncommitted · 2 unstaged');
    expect(html).toContain('Review required before deleting');
    expect(html).toContain('os-yoga-unix');
    expect(html).toContain('1 uncommitted · 0 unstaged');
    expect(html).toContain('Delete branch');
    expect(html).toContain('data-testid="task-mobile-primary-action"');
    expect(html).not.toContain('Start development');
  });

  test('groups the desktop navigation and supports a compact sidebar', () => {
    expect(projectPageGroups.map((group) => group.label)).toEqual([
      'Project',
      'Global'
    ]);
    const expanded = renderToStaticMarkup(
      <ProjectSidebar
        activePage="issues"
        currentProject={projectFixtures[0]}
        onClose={() => undefined}
        onCollapsedChange={() => undefined}
        onNewIssue={() => undefined}
        onPageChange={() => undefined}
        onProjectSelect={() => undefined}
        portalContainer={null}
      />
    );
    const collapsed = renderToStaticMarkup(
      <ProjectSidebar
        activePage="issues"
        collapsed
        currentProject={projectFixtures[0]}
        onClose={() => undefined}
        onCollapsedChange={() => undefined}
        onNewIssue={() => undefined}
        onPageChange={() => undefined}
        onProjectSelect={() => undefined}
        portalContainer={null}
      />
    );

    expect(expanded).toContain('Collapse sidebar');
    expect(expanded).toContain('>Project<');
    expect(expanded).toContain('>Global<');
    expect(expanded).toContain('>New task<');
    expect(expanded).toContain('>Chat<');
    expect(expanded).not.toContain('>Codex<');
    expect(expanded).not.toContain('uppercase');
    expect(collapsed).toContain('Expand sidebar');
    expect(collapsed).not.toContain('>Project<');
    expect(collapsed).toContain('title="Tasks"');
  });
});
