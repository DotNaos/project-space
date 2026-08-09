import type { ComputeInventorySnapshot } from '../../src/shared/compute-environment-api';
import type {
  GitHubCodespaceRunnerRequest,
  GitHubCodespaceRunnerResult
} from '../../src/shared/github-codespace-runner-api';
import { GITHUB_CODESPACE_RUNNER_API_VERSION } from '../../src/shared/github-codespace-runner-api';
import {
  CODEX_AUTHORIZATION_REQUIRED_CONNECTOR_CAPABILITY,
  CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY
} from '../../src/shared/codex-machine-tasks-api';
import type { MachineRecord } from '../../src/shared/project-space-api';

export interface GitHubCodespaceRecord {
  createdAt: string;
  displayName?: string;
  name: string;
  repositoryFullName: string;
  state: string;
  url?: string;
  ref?: string;
}

export interface GitHubCodespaceRunnerDependencies {
  create(input: {
    branch: string;
    displayName: string;
    repositoryFullName: string;
  }): Promise<GitHubCodespaceRecord>;
  delete(name: string): Promise<void>;
  findApproval(input: {
    codespaceName: string;
    createdAt: string;
  }): Promise<{ approvalUrl: string } | null>;
  inventory(): Promise<{
    compute: ComputeInventorySnapshot;
    connectors: MachineRecord[];
  }>;
  list(): Promise<GitHubCodespaceRecord[]>;
  start(name: string): Promise<GitHubCodespaceRecord>;
  stop(name: string): Promise<GitHubCodespaceRecord>;
}

const activeStates = new Set(['Available']);
const stoppedStates = new Set(['Shutdown']);
const failedStates = new Set(['Failed', 'Unavailable']);

export function createGitHubCodespaceRunnerService(
  dependencies: GitHubCodespaceRunnerDependencies
) {
  return {
    async run(request: GitHubCodespaceRunnerRequest): Promise<GitHubCodespaceRunnerResult> {
      let codespace: GitHubCodespaceRecord | undefined = await findCodespace(
        dependencies,
        request
      );

      if (!codespace && request.action !== 'provision' && request.action !== 'status') {
        return result(request, 'not-created', 'Create the GitHub Codespace first.');
      }
      if (!codespace && request.action === 'status') {
        return result(request, 'not-created', 'No GitHub Codespace exists for this task yet.');
      }
      if (!codespace && request.action === 'provision') {
        try {
          codespace = await dependencies.create({
            branch: request.branch,
            displayName: displayName(request),
            repositoryFullName: request.repositoryFullName
          });
        } catch (error) {
          // Creation has an uncertain network boundary. Re-list before reporting failure so a
          // successful GitHub request is never repeated into a duplicate Codespace.
          const reconciled = await findCodespace(dependencies, request).catch(
            (): GitHubCodespaceRecord | undefined => undefined
          );
          codespace = reconciled;
          if (!codespace) throw error;
        }
      }

      if (!codespace) {
        return result(request, 'failed', 'The GitHub Codespace could not be reconciled.');
      }
      if (request.action === 'delete') {
        await dependencies.delete(codespace.name);
        return result(request, 'not-created', 'The GitHub Codespace was deleted.');
      }
      if (request.action === 'start' && stoppedStates.has(codespace.state)) {
        codespace = await dependencies.start(codespace.name);
      }
      if (request.action === 'stop' && !stoppedStates.has(codespace.state)) {
        codespace = await dependencies.stop(codespace.name);
      }
      if (request.action === 'stop') {
        return result(request, 'offline', 'The GitHub Codespace is stopping.', codespace);
      }
      if (stoppedStates.has(codespace.state)) {
        return result(request, 'offline', 'The GitHub Codespace is stopped.', codespace);
      }
      if (failedStates.has(codespace.state)) {
        return result(request, 'failed', `GitHub reported the Codespace as ${codespace.state}.`, codespace);
      }

      const inventory = await dependencies.inventory();
      const connector = inventory.connectors.find((candidate) => candidate.name === codespace!.name);
      const environmentId = connector
        ? inventory.compute.connectors.find(
            (association) => association.connectorId === connector.id
          )?.environmentId
        : undefined;
      const environment = inventory.compute.environments.find(
        (candidate) => candidate.id === environmentId && candidate.kind === 'github_codespace'
      );

      if (!connector || !environment) {
        const approval = await dependencies.findApproval({
          codespaceName: codespace.name,
          createdAt: codespace.createdAt
        });
        if (approval) {
          return {
            ...result(
              request,
              'connector-approval-required',
              'Approve this exact Codespace once so it can connect to Project Space.',
              codespace
            ),
            approvalUrl: approval.approvalUrl
          };
        }
        return result(
          request,
          'provisioning',
          activeStates.has(codespace.state)
            ? 'The Codespace is installing and connecting its managed runner.'
            : `GitHub is preparing the Codespace (${codespace.state}).`,
          codespace
        );
      }

      const capabilities = connector.connector.capabilities ?? [];
      const target = { connectorId: connector.id, environmentId: environment?.id };
      if (capabilities.includes(CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY)) {
        return { ...result(request, 'ready', 'The Codespace and Codex are ready.', codespace), ...target };
      }
      if (capabilities.includes(CODEX_AUTHORIZATION_REQUIRED_CONNECTOR_CAPABILITY)) {
        return {
          ...result(
            request,
            'authorization-required',
            'Sign in to Codex with your ChatGPT subscription.',
            codespace
          ),
          ...target
        };
      }
      return {
        ...result(request, 'provisioning', 'The managed Codex runtime is still becoming ready.', codespace),
        ...target
      };
    }
  };
}

async function findCodespace(
  dependencies: GitHubCodespaceRunnerDependencies,
  request: GitHubCodespaceRunnerRequest
) {
  const matches = (await dependencies.list()).filter((candidate) =>
    candidate.repositoryFullName.toLowerCase() === request.repositoryFullName.toLowerCase() &&
    candidate.ref === request.branch
  );
  const exact = matches.filter((candidate) => candidate.displayName === displayName(request));
  if (exact.length > 1 || (exact.length === 0 && matches.length > 1)) {
    throw new Error('Multiple GitHub Codespaces match this exact task branch. Delete the duplicate before continuing.');
  }
  return exact[0] ?? matches[0];
}

function displayName(request: GitHubCodespaceRunnerRequest) {
  return `Project Space #${request.issue}`;
}

function result(
  request: GitHubCodespaceRunnerRequest,
  state: GitHubCodespaceRunnerResult['state'],
  message: string,
  codespace?: GitHubCodespaceRecord
): GitHubCodespaceRunnerResult {
  return {
    apiVersion: GITHUB_CODESPACE_RUNNER_API_VERSION,
    ...(codespace ? {
      codespace: {
        name: codespace.name,
        state: codespace.state,
        ...(codespace.url ? { url: codespace.url } : {})
      }
    } : {}),
    message,
    operationId: request.operationId,
    state
  };
}
