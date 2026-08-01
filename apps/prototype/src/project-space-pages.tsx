import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  CircleDot,
  FileCheck2,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  LayoutDashboard,
  MessageCircle,
  Monitor,
  Rocket
} from 'lucide-react';

import type { PrototypeScenarioKind } from '../../../src/shared/prototype-canvas';

export type ProjectPageId =
  | 'overview'
  | 'issues'
  | 'branches'
  | 'machines'
  | 'workspaces'
  | 'chats'
  | 'history'
  | 'codex'
  | 'template'
  | 'deployments';

export interface ProjectPageItem {
  count?: number;
  description: string;
  icon: LucideIcon;
  id: ProjectPageId;
  label: string;
}

export const projectPageItems: ProjectPageItem[] = [
  {
    description: 'Project pulse and recent activity',
    icon: LayoutDashboard,
    id: 'overview',
    label: 'Overview'
  },
  {
    count: 57,
    description: 'Features, bugs, and planned work',
    icon: CircleDot,
    id: 'issues',
    label: 'Issues'
  },
  {
    count: 16,
    description: 'Repository branches and their state',
    icon: GitBranch,
    id: 'branches',
    label: 'Branches'
  },
  {
    description: 'Available development destinations',
    icon: Monitor,
    id: 'machines',
    label: 'Machines'
  },
  {
    description: 'Worktrees and active working copies',
    icon: FolderGit2,
    id: 'workspaces',
    label: 'Workspaces'
  },
  {
    count: 3,
    description: 'Project conversations and decisions',
    icon: MessageCircle,
    id: 'chats',
    label: 'Chats'
  },
  {
    description: 'Commits, revisions, and repository activity',
    icon: GitCommitHorizontal,
    id: 'history',
    label: 'History'
  },
  {
    description: 'Active and completed Codex tasks',
    icon: Bot,
    id: 'codex',
    label: 'Codex'
  },
  {
    description: 'Project conventions and setup status',
    icon: FileCheck2,
    id: 'template',
    label: 'Template'
  },
  {
    description: 'Preview, release, and production runs',
    icon: Rocket,
    id: 'deployments',
    label: 'Deployments'
  }
];

interface PageRow {
  detail: string;
  meta: string;
  title: string;
}

const pageRows: Record<Exclude<ProjectPageId, 'overview'>, PageRow[]> = {
  branches: [
    { detail: 'Default branch', meta: 'dc6bd8d · 4h ago', title: 'main' },
    {
      detail: 'Frontend redesign prototype',
      meta: 'working · local',
      title: 'issue-437-redesign-the-project-space-frontend'
    },
    { detail: 'Release preparation', meta: 'ready', title: 'release/v0.4.56' }
  ],
  chats: [
    { detail: 'Sidebar and navigation direction', meta: 'Now', title: 'Frontend redesign' },
    { detail: 'Preparing the next Project Space release', meta: 'Yesterday', title: 'Release coordination' },
    { detail: 'Feedback from the local review surface', meta: 'Jul 31', title: 'Prototype review' }
  ],
  codex: [
    { detail: 'Working on the selected frontend direction', meta: 'Active', title: '#437 · Frontend redesign' },
    { detail: 'Local checks and release preparation', meta: 'Completed', title: '#434 · PR revisions' },
    { detail: 'Preview capacity and trusted controls', meta: 'Planned', title: '#426 · Preview hub' }
  ],
  deployments: [
    { detail: 'Production · v0.4.56', meta: 'Healthy', title: 'Deploy main' },
    { detail: 'Pull request preview', meta: 'Offline', title: 'Preview #437' },
    { detail: 'Signed release', meta: 'Published', title: 'Release v0.4.56' }
  ],
  history: [
    { detail: 'Release Project Space v0.4.56', meta: 'dc6bd8d · 4h ago', title: 'main' },
    { detail: 'Make PR revisions green on first push', meta: '419a88b · 6h ago', title: 'issue-434' },
    { detail: 'Improve CI/CD reliability and speed', meta: 'd07b6ec · yesterday', title: 'issue-419' }
  ],
  issues: [
    { detail: 'Frontend · redesign', meta: 'Open', title: '#437 · Redesign the Project Space frontend' },
    { detail: 'CI/CD · reliability', meta: 'Closed', title: '#434 · Make PR revisions green' },
    { detail: 'Preview · infrastructure', meta: 'Open', title: '#426 · On-demand PR Preview hub' },
    { detail: 'CI/CD · performance', meta: 'Closed', title: '#419 · Improve CI/CD reliability' }
  ],
  machines: [
    { detail: 'Local development destination', meta: 'Online', title: 'os-pc' },
    { detail: 'Portable development destination', meta: 'Sleeping', title: 'os-yoga-unix' },
    { detail: 'Production host', meta: 'Online', title: 'project-space-vps' }
  ],
  template: [
    { detail: 'Required project metadata is present', meta: 'Complete', title: 'project.yaml' },
    { detail: 'Repository structure matches the template', meta: 'Complete', title: 'Template adherence' },
    { detail: 'Local Project CLI is available', meta: 'Ready', title: 'Project CLI' }
  ],
  workspaces: [
    { detail: 'Issue-owned worktree', meta: 'Active', title: 'issue-437-redesign-the-project-space-frontend' },
    { detail: 'Shared orientation checkout', meta: 'Read only', title: 'main' },
    { detail: 'Release verification worktree', meta: 'Idle', title: 'issue-434-make-pr-revisions-green' }
  ]
};

const overviewActivity = [
  { detail: 'Frontend redesign prototype updated', meta: 'Now', title: '#437' },
  { detail: 'Production deployment verified', meta: '4h ago', title: 'v0.4.56' },
  { detail: 'PR reliability work completed', meta: '6h ago', title: '#434' }
];

function PageList({ rows }: { rows: PageRow[] }) {
  return (
    <div className="border-y border-current/[.08]">
      {rows.map((row) => (
        <button
          className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-current/[.07] px-1 py-4 text-left transition-colors last:border-b-0 hover:bg-current/[.025] @md:px-3"
          key={`${row.title}-${row.detail}`}
          type="button"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{row.title}</span>
            <span className="mt-1 block truncate text-xs text-current/45">{row.detail}</span>
          </span>
          <span className="pt-0.5 text-xs text-current/40">{row.meta}</span>
        </button>
      ))}
    </div>
  );
}

export function ProjectFeaturePage({
  page,
  projectName,
  scenario
}: {
  page: Exclude<ProjectPageId, 'overview'>;
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const definition = projectPageItems.find((item) => item.id === page) ?? projectPageItems[1];
  const rows = scenario === 'empty' ? [] : pageRows[page];
  const Icon = definition.icon;

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col px-6 pb-8 pt-5 @md:px-9 @md:pt-8 @3xl:px-12 @3xl:pt-12">
      <header className="shrink-0 border-b border-current/[.08] pb-6">
        <p className="text-xs text-current/40">{projectName}</p>
        <div className="mt-3 flex items-center gap-3">
          <Icon aria-hidden className="size-5 text-current/55" strokeWidth={1.7} />
          <h1 className="text-2xl font-semibold tracking-[-0.025em] @md:text-3xl">
            {definition.label}
          </h1>
        </div>
        <p className="mt-2 max-w-xl text-sm leading-6 text-current/45">
          {definition.description}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pt-7">
        {scenario === 'offline' ? (
          <p className="border-y border-current/[.08] py-8 text-sm text-current/45">
            This page is waiting for the development destination to reconnect.
          </p>
        ) : rows.length ? (
          <PageList rows={rows} />
        ) : (
          <p className="border-y border-current/[.08] py-8 text-sm text-current/45">
            Nothing here yet.
          </p>
        )}
      </div>
    </section>
  );
}

export function ProjectOverviewPage({ projectName }: { projectName: string }) {
  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col px-6 pb-8 pt-5 @md:px-9 @md:pt-8 @3xl:px-12 @3xl:pt-12">
      <header className="shrink-0 border-b border-current/[.08] pb-6">
        <p className="text-xs text-current/40">{projectName}</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-[-0.025em] @md:text-3xl">Overview</h1>
        <p className="mt-2 text-sm text-current/45">A quiet pulse of the current project.</p>
        <dl className="mt-6 flex divide-x divide-current/[.1]">
          {[
            ['Issues', '57'],
            ['Branches', '16'],
            ['Active chats', '3']
          ].map(([label, value]) => (
            <div className="min-w-0 flex-1 px-4 first:pl-0" key={label}>
              <dt className="truncate text-[11px] text-current/40">{label}</dt>
              <dd className="mt-1 text-xl font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pt-7">
        <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-current/35">
          Recent activity
        </p>
        <PageList rows={overviewActivity} />
      </div>
    </section>
  );
}
