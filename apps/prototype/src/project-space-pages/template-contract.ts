export type ProjectTemplateGroupId = "Modules" | "Libraries" | "Configuration" | "Pipelines";

export interface ProjectTemplateRequirement {
  detail: string;
  id: string;
  label: string;
}

export interface ProjectTemplateGroup {
  id: ProjectTemplateGroupId;
  requirements: ProjectTemplateRequirement[];
}

export const projectTemplateGroups: ProjectTemplateGroup[] = [
  {
    id: "Modules",
    requirements: [
      { detail: "React web application built with Vite and TypeScript", id: "module-frontend", label: "Frontend" },
      { detail: "Node.js service with typed HTTP boundaries", id: "module-backend", label: "Backend · Node.js" },
      { detail: "Go command-line application using Cobra", id: "module-cli", label: "CLI · Go" },
      { detail: "Versioned product documentation written in MDX", id: "module-docs", label: "Documentation" },
    ],
  },
  {
    id: "Libraries",
    requirements: [
      { detail: "HeroUI v3 components and React Aria behavior", id: "library-ui", label: "HeroUI" },
      { detail: "Tailwind CSS v4 for shared styling", id: "library-styles", label: "Tailwind CSS" },
      { detail: "Zod schemas at external data boundaries", id: "library-validation", label: "Zod" },
      { detail: "Bun test and Vitest-compatible frontend coverage", id: "library-tests", label: "Test tooling" },
    ],
  },
  {
    id: "Configuration",
    requirements: [
      { detail: "Bun is the package manager and JavaScript runtime", id: "config-runtime", label: "Runtime · Bun" },
      { detail: "Strict TypeScript and checked project references", id: "config-typescript", label: "Type safety" },
      { detail: "Structured server logs with request identity", id: "config-logging", label: "Logging" },
      { detail: "Authenticated application and privileged operations", id: "config-auth", label: "Authentication" },
    ],
  },
  {
    id: "Pipelines",
    requirements: [
      { detail: "Required local and remote checks on every pull request", id: "pipeline-pr", label: "Pull request checks" },
      { detail: "One coherent, signed release identity bundle", id: "pipeline-release", label: "Signed release" },
      { detail: "Exact-commit production deployment through Project CLI", id: "pipeline-deploy", label: "Production deployment" },
      { detail: "Health verification and a documented rollback path", id: "pipeline-health", label: "Health and rollback" },
    ],
  },
];

export type TemplateRequirementState = "Attention" | "Valid";

export interface TemplateCheckRequirement extends ProjectTemplateRequirement {
  state: TemplateRequirementState;
}

export interface TemplateCheckGroup {
  id: ProjectTemplateGroupId;
  requirements: TemplateCheckRequirement[];
}

function attentionRequirementIds(branchName: string) {
  if (branchName === "main") return new Set<string>();
  if (branchName.includes("437")) return new Set(["pipeline-release"]);
  if (branchName.includes("398")) return new Set(["config-auth", "pipeline-pr"]);
  return new Set(["config-logging"]);
}

export function projectTemplateCheckForBranch(branchName: string): TemplateCheckGroup[] {
  const attention = attentionRequirementIds(branchName);
  return projectTemplateGroups.map((group) => ({
    ...group,
    requirements: group.requirements.map((requirement) => ({
      ...requirement,
      state: attention.has(requirement.id) ? "Attention" : "Valid",
    })),
  }));
}

export function projectTemplateCheckSummary(branchName: string) {
  const requirements = projectTemplateCheckForBranch(branchName).flatMap((group) => group.requirements);
  const valid = requirements.filter((requirement) => requirement.state === "Valid").length;
  return { total: requirements.length, valid };
}
