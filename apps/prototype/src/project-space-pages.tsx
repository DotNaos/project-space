import type { LucideIcon } from "lucide-react";
import {
  CircleDot,
  FileCheck2,
  FolderGit2,
  LayoutDashboard,
  MessageCircle,
  Monitor,
  Rocket,
} from "lucide-react";

import type { PrototypeScenarioKind } from "../../../src/shared/prototype-canvas";
import { ProjectOverviewPage } from "./project-space-pages/overview-and-issues";
import { ProjectTasksPage } from "./project-space-pages/tasks";
import { initialMockTasks, type MockTask } from "./project-space-pages/task-model";
import { ProjectBranchesPage } from "./project-space-pages/branches-and-workspaces";
import {
  ProjectDeploymentsPage,
  ProjectMachinesPage,
} from "./project-space-pages/machines-and-deployments";
import { ProjectChatsPage } from "./project-space-pages/collaboration-and-history";
import { ProjectTemplatePage } from "./project-space-pages/template";

export type ProjectPageId =
  | "overview"
  | "issues"
  | "branches"
  | "machines"
  | "chats"
  | "template"
  | "deployments";

export interface ProjectPageItem {
  icon: LucideIcon;
  id: ProjectPageId;
  label: string;
}

export const projectPageItems: ProjectPageItem[] = [
  { icon: LayoutDashboard, id: "overview", label: "Overview" },
  { icon: CircleDot, id: "issues", label: "Tasks" },
  { icon: FolderGit2, id: "branches", label: "Repository" },
  { icon: Monitor, id: "machines", label: "Machines" },
  { icon: MessageCircle, id: "chats", label: "Chat" },
  { icon: FileCheck2, id: "template", label: "Templates" },
  { icon: Rocket, id: "deployments", label: "Deployments" },
];

export function ProjectFeaturePage({
  onNavigate,
  onNewTask = () => undefined,
  onTaskOpen = () => undefined,
  page,
  projectName,
  scenario,
  tasks = initialMockTasks,
}: {
  onNavigate?(page: ProjectPageId): void;
  onNewTask?(): void;
  onTaskOpen?(number: number): void;
  page: ProjectPageId;
  projectName: string;
  scenario: PrototypeScenarioKind;
  tasks?: MockTask[];
}) {
  const props = { projectName, scenario };
  switch (page) {
    case "overview":
      return <ProjectOverviewPage onNavigate={onNavigate} onNewIssue={onNewTask} projectName={projectName} />;
    case "issues":
      return (
        <ProjectTasksPage
          onNewTask={onNewTask}
          onOpenTask={onTaskOpen}
          projectName={projectName}
          tasks={tasks}
        />
      );
    case "branches":
      return <ProjectBranchesPage {...props} />;
    case "machines":
      return <ProjectMachinesPage {...props} />;
    case "chats":
      return <ProjectChatsPage {...props} />;
    case "template":
      return <ProjectTemplatePage {...props} />;
    case "deployments":
      return <ProjectDeploymentsPage {...props} />;
  }
}

export { ProjectOverviewPage };
export { ProjectTasksPage } from "./project-space-pages/tasks";
export { ProjectTaskDetailPage } from "./project-space-pages/task-detail";
export { NewTaskPage } from "./project-space-pages/new-task";
export { initialMockTasks, mockTaskGroup, mockTaskStageLabel, updateMockTask } from "./project-space-pages/task-model";
export type { MockTask, MockTaskAction, MockTaskStage, MockTaskType } from "./project-space-pages/task-model";
export { ProjectIssuesPage, filterAndSortPrototypeIssues } from "./project-space-pages/issues";
export { ProjectIssueDetailPage } from "./project-space-pages/issue-detail";
export { prototypeIssueByNumber } from "./project-space-pages/issue-fixtures";
export type { PrototypeIssueViewMode } from "./project-space-pages/issues";
