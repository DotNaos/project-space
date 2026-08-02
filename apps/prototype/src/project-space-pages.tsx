import type { LucideIcon } from "lucide-react";
import {
  CircleDot,
  FileCheck2,
  GitBranch,
  LayoutDashboard,
  MessageCircle,
  Monitor,
  Rocket,
} from "lucide-react";

import type { PrototypeScenarioKind } from "../../../src/shared/prototype-canvas";
import { ProjectOverviewPage } from "./project-space-pages/overview-and-issues";
import {
  ProjectIssuesPage,
  type PrototypeIssueViewMode,
} from "./project-space-pages/issues";
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
  { icon: CircleDot, id: "issues", label: "Issues" },
  { icon: GitBranch, id: "branches", label: "Branches" },
  { icon: Monitor, id: "machines", label: "Machines" },
  { icon: MessageCircle, id: "chats", label: "Chat" },
  { icon: FileCheck2, id: "template", label: "Template" },
  { icon: Rocket, id: "deployments", label: "Deployments" },
];

export function ProjectFeaturePage({
  issueViewMode = "board",
  onIssueOpen = () => undefined,
  onIssueViewModeChange = () => undefined,
  onNavigate,
  onNewIssue,
  page,
  projectName,
  scenario,
}: {
  issueViewMode?: PrototypeIssueViewMode;
  onIssueOpen?(number: number): void;
  onIssueViewModeChange?(viewMode: PrototypeIssueViewMode): void;
  onNavigate?(page: ProjectPageId): void;
  onNewIssue?(): void;
  page: ProjectPageId;
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const props = { projectName, scenario };
  switch (page) {
    case "overview":
      return <ProjectOverviewPage onNavigate={onNavigate} onNewIssue={onNewIssue} projectName={projectName} />;
    case "issues":
      return (
        <ProjectIssuesPage
          {...props}
          onNewIssue={onNewIssue}
          onOpenIssue={onIssueOpen}
          onViewModeChange={onIssueViewModeChange}
          viewMode={issueViewMode}
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
export { ProjectIssueDetailPage } from "./project-space-pages/issue-detail";
export { prototypeIssueByNumber } from "./project-space-pages/issue-fixtures";
export type { PrototypeIssueViewMode } from "./project-space-pages/issues";
