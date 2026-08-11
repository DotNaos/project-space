import { Cloud, ExternalLink, Server } from "lucide-react";
import { useState } from "react";

import { MachinesPage } from '../../../../src/features/project-desktop/components/machines-page';
import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import { DeploymentDetailView, type PrototypeDeployment } from "./deployment-detail";
import {
  PagePrimaryAction,
  PageScaffold,
  PageState,
  PageStatus,
  SectionHeading,
} from "./page-foundation";
import {
  machineRuntimePrototypeConnectors,
  machineRuntimePrototypeCredentials,
  machineRuntimePrototypePhysicalMachines
} from './machine-runtime-fixtures';

export function ProjectMachinesPage({
  projectName: _projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  return (
    <div className="h-full min-h-0 px-5 pt-5 @5xl:px-8 @5xl:pt-7">
      <MachinesPage
        connectors={scenario === 'empty' ? [] : machineRuntimePrototypeConnectors}
        credentialListError=""
        credentials={scenario === 'empty' ? [] : machineRuntimePrototypeCredentials}
        hasCopiedInstallCommand={false}
        installCommand="project connector install"
        installScriptHref="/install"
        installerError=""
        isGeneratingInstaller={false}
        loadError={scenario === 'offline' ? 'The connector registry is temporarily unavailable.' : ''}
        onCopyInstallCommand={() => undefined}
        onGenerateInstallCommand={() => undefined}
        onRefresh={async () => undefined}
        onRefreshCredentials={() => undefined}
        onRevokeCredential={() => undefined}
        onSaveMachine={async () => undefined}
        physicalMachines={scenario === 'empty' ? [] : machineRuntimePrototypePhysicalMachines}
        revokingCredentialId=""
        status={scenario === 'offline' ? 'error' : 'ready'}
        tailscale={{
          connected: true,
          installed: true,
          ips: ['100.64.0.5'],
          peersOnline: 4,
          serveOrigins: ['https://project-space.tailnet.example']
        }}
      />
    </div>
  );
}

const deploymentGroups: Array<{ rows: PrototypeDeployment[]; title: string }> = [
  {
    title: "Production",
    rows: [
      { commit: "dc6bd8d", detail: "projects.os-home.net", name: "Project Space", status: "Healthy", time: "4h", tone: "success" as const, version: "v0.4.56" },
    ],
  },
  {
    title: "Pull request previews",
    rows: [
      { commit: "72c0f48", detail: "Issue #437 · frontend redesign", name: "Local prototype", status: "Running", time: "now", tone: "info" as const, version: "branch" },
      { commit: "2550cd7", detail: "PR #426 · Preview hub", name: "Preview deployment", status: "Offline", time: "2h", tone: "muted" as const, version: "preview" },
    ],
  },
  {
    title: "Releases",
    rows: [
      { commit: "dc6bd8d", detail: "Signed release · GitHub", name: "Project Space", status: "Published", time: "4h", tone: "success" as const, version: "v0.4.56" },
      { commit: "d07b6ec", detail: "Signed release · GitHub", name: "Project Space", status: "Published", time: "yesterday", tone: "success" as const, version: "v0.4.51" },
    ],
  },
];

export function ProjectDeploymentsPage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const unavailable = scenario === "empty" || scenario === "offline";
  const [selectedDeployment, setSelectedDeployment] = useState<PrototypeDeployment | null>(null);

  if (selectedDeployment) return <DeploymentDetailView deployment={selectedDeployment} onBack={() => setSelectedDeployment(null)} />;

  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<ExternalLink className="size-4" />}>Open production</PagePrimaryAction>}
      description="Preview, release, and production stay visibly separate until each step is proven."
      projectName={projectName}
      title="Deployments"
    >
      {unavailable ? <PageState emptyCopy="Deployments will appear after the first preview or release." scenario={scenario} /> : (
        <div className="space-y-8 py-6 @5xl:py-8">
          {deploymentGroups.map((group) => (
            <section key={group.title}>
              <SectionHeading>{group.title}</SectionHeading>
              <div className="divide-y divide-current/[.07] border-y border-current/[.08]">
                {group.rows.map((row) => (
                  <button
                    className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-4 text-left hover:bg-current/[.02] @md:grid-cols-[auto_minmax(0,1fr)_8rem_5rem_auto] @md:gap-4"
                    key={`${row.name}-${row.version}`}
                    onClick={() => setSelectedDeployment(row)}
                    type="button"
                  >
                    <span className="grid size-9 place-items-center rounded-full bg-current/[.06] text-current/45">
                      {group.title === "Production" ? <Cloud className="size-4" /> : <Server className="size-4" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{row.name}</span>
                      <span className="mt-1 block truncate text-xs text-current/40">{row.detail}</span>
                    </span>
                    <span className="hidden font-mono text-xs text-current/35 @md:block">{row.commit}</span>
                    <span className="hidden text-xs text-current/30 @md:block">{row.time}</span>
                    <PageStatus tone={row.tone}>{row.status}</PageStatus>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageScaffold>
  );
}
