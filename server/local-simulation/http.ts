import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  tailscaleDeviceClassifications,
  type TailscaleDeviceClassification
} from '../../src/shared/tailscale-inventory-api';
import type { RuntimeBindingEvidence } from '../runtime-binding';
import { normalizeCodexMachineTaskWorker } from '../../src/shared/codex-machine-tasks-api';
import { readJson, writeJson } from '../project-space-http-response';
import { legacyConnectorRetirement } from '../legacy-connector-retirement';
import { localSimulationAvatarUrl, localSimulationIdentity } from './seed';
import { handleLocalSimulationGitHubMutation } from './github-http';
import { LocalSimulationStore } from './store';
import type { LocalSimulationState } from './state';
import { handleLocalSimulationWorktreeRequest } from './worktree-http';
import {
  checkedAt,
  connectorOverview,
  devServerOverview,
  localSimulationCsp,
  projectRecord
} from './views';

const simulatedTailscaleDevices = [
  { addresses: ['100.101.0.2', 'fd7a:115c:a1e0::2'], id: 'local-sim-device-a', name: 'development-mac', online: true, os: 'macOS' },
  { addresses: ['100.101.0.3', 'fd7a:115c:a1e0::3'], id: 'local-sim-device-b', name: 'remote-linux', online: false, os: 'linux' }
] as const;

function currentWorktree(state: LocalSimulationState) {
  const worktree = state.worktrees[0];
  if (!worktree || !worktree.branchName || !worktree.headSha) {
    throw new Error('Local simulation worktree identity is missing.');
  }
  return { ...worktree, branchName: worktree.branchName, headSha: worktree.headSha };
}

function simulatedTailscaleConnection(state: LocalSimulationState) {
  return {
    ...(state.tailscale ? {
      connectionState: 'connected' as const,
      source: 'tailscale_oauth_api' as const
    } : {
      connectionState: 'not_configured' as const,
      source: 'not_connected' as const
    }),
    requiredScope: 'devices:core:read' as const
  };
}

export function createLocalSimulationRequestHandler(options: {
  binding: RuntimeBindingEvidence;
  repositoryRoot: string;
}) {
  if (!options.binding.simulationStatePath) {
    throw new Error('Local simulation state evidence is missing.');
  }
  const store = new LocalSimulationStore(options.binding.simulationStatePath, options.repositoryRoot);

  return async function handleLocalSimulationRequest(
    request: IncomingMessage,
    response: ServerResponse
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Security-Policy', localSimulationCsp);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const state = await store.read();
    const repository = state.github.repository;
    const method = request.method ?? 'GET';

    if (await handleLocalSimulationGitHubMutation({ method, request, response, state, store, url })) {
      return;
    }
    if (await handleLocalSimulationWorktreeRequest({
      method, repositoryRoot: options.repositoryRoot, request, response, state, store, url
    })) {
      return;
    }

    if (method === 'GET' && url.pathname === '/api/health') {
      writeJson(response, 200, { ok: true, runtime: 'local-simulation' });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/app/meta') {
      writeJson(response, 200, {
        environment: 'Local simulation',
        name: 'Project Space',
        nodeVersion: process.version,
        platform: process.platform,
        runtime: {
					accessUrl: options.binding.accessUrl,
          apis: options.binding.apis,
          data: options.binding.data,
          network: options.binding.network,
          secrets: 'none'
        },
        version: 'unknown'
      });
      return;
    }
    if (url.pathname === '/api/compute/tailscale/connection') {
      if (method === 'GET') {
        writeJson(response, 200, simulatedTailscaleConnection(state));
        return;
      }
      writeJson(response, 405, { error: 'Method not allowed.' });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/compute/tailscale/devices') {
      const now = new Date().toISOString();
      writeJson(response, 200, {
        devices: state.tailscale ? simulatedTailscaleDevices.map((device) => ({
          addresses: [...device.addresses],
          classification: state.tailscale?.classifications[device.id] ?? 'unclassified',
          id: device.id,
          name: device.name,
          network: {
            checkedAt: now,
            freshUntil: new Date(Date.now() + 60_000).toISOString(),
            lastSeenAt: now,
            state: device.online ? 'online' : 'offline'
          },
          os: device.os,
          revision: state.tailscale?.revisions?.[device.id] ?? 0,
          tags: ['tag:development']
        })) : [],
        provider: state.tailscale ? {
          connectionState: 'connected',
          refreshState: 'available',
          source: 'tailscale_oauth_api'
        } : {
          connectionState: 'not_configured',
          reasonCode: 'connection_missing',
          refreshState: 'not_checked',
          source: 'not_connected'
        },
        schemaVersion: 1
      });
      return;
    }
    const simulatedClassification = url.pathname.match(/^\/api\/compute\/tailscale\/devices\/([^/]+)\/classification$/);
    if (method === 'POST' && simulatedClassification) {
      const deviceId = decodeURIComponent(simulatedClassification[1] ?? '');
      const payload = await readJson<{ classification?: unknown; expectedRevision?: unknown }>(request);
      const classifications = new Set<string>(tailscaleDeviceClassifications);
      const currentRevision = state.tailscale?.revisions?.[deviceId] ?? 0;
      if (!state.tailscale || !simulatedTailscaleDevices.some((device) => device.id === deviceId) ||
        typeof payload.classification !== 'string' || !classifications.has(payload.classification) ||
        payload.expectedRevision !== currentRevision) {
        writeJson(response, 409, { error: 'The simulated Tailnet device changed.' });
        return;
      }
      await store.update((current) => {
        if (current.tailscale) {
          current.tailscale.classifications[deviceId] = payload.classification as TailscaleDeviceClassification;
          current.tailscale.revisions = {
            ...current.tailscale.revisions,
            [deviceId]: currentRevision + 1
          };
        }
      });
      const updated = await store.read();
      const device = simulatedTailscaleDevices.find((candidate) => candidate.id === deviceId)!;
      writeJson(response, 200, {
        addresses: [...device.addresses],
        classification: updated.tailscale?.classifications[deviceId],
        id: device.id,
        name: device.name,
        network: { checkedAt: updated.updatedAt, freshUntil: new Date(Date.now() + 60_000).toISOString(), state: device.online ? 'online' : 'offline' },
        os: device.os,
        revision: updated.tailscale?.revisions?.[deviceId] ?? currentRevision + 1,
        tags: ['tag:development']
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/local-simulation') {
      writeJson(response, 200, {
        createdAt: state.createdAt,
        revision: state.revision,
        scenario: state.scenario,
        updatedAt: state.updatedAt
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/local-simulation/reset') {
      const reset = await store.reset();
      writeJson(response, 200, { revision: reset.revision, scenario: reset.scenario });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/projects/state') {
      writeJson(response, 200, state.projectsState);
      return;
    }
    if (method === 'PUT' && url.pathname === '/api/projects/state') {
      const next = await readJson<LocalSimulationState['projectsState']>(request);
      await store.update((current) => { current.projectsState = next; });
      writeJson(response, 200, {});
      return;
    }
    if (method === 'GET' && url.pathname === '/api/projects/discovery') {
      const project = projectRecord(state, options.repositoryRoot);
      writeJson(response, 200, {
        groups: [], projects: [project], rootItems: [{ id: project.id, kind: 'project', label: project.name, projectId: project.id }],
        rootPath: options.repositoryRoot, structureViolations: []
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/connectors/overview') {
      writeJson(response, 200, connectorOverview(state, options.repositoryRoot));
      return;
    }
    if (
      url.pathname === '/api/connectors/credentials' ||
      url.pathname === '/api/connectors/project-registry'
    ) {
      writeJson(response, 410, legacyConnectorRetirement);
      return;
    }
    if (method === 'GET' && url.pathname === '/api/physical-machines') {
      writeJson(response, 200, {
        machines: [{ connectorIds: [state.machine.id], id: 'local-computer', name: 'Local computer' }]
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/github/catalog') {
      writeJson(response, 200, {
        cache: { lastUpdated: state.updatedAt, state: 'fresh' },
        checkedAt: checkedAt(),
        repositories: [projectRecord(state, options.repositoryRoot).github],
        status: 'connected'
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/github/issue-metadata') {
      writeJson(response, 200, {
        attachmentStorage: 'per-issue-branch',
        attachmentWrite: 'denied',
        fullName: repository.fullName,
        labels: [
          { color: 'a2eeef', description: 'New feature or request', name: 'enhancement' },
          { color: '0e8a16', description: 'Local development work', name: 'local-development' }
        ],
        labelWrite: 'unverified',
        status: 'connected'
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/github/repository-details') {
      writeJson(response, 200, {
        branches: state.github.branches,
        checkedAt: checkedAt(),
        issues: state.github.issues,
        pullRequests: state.github.pullRequests,
        status: 'connected'
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/github/issue-comments') {
      writeJson(response, 200, {
        comments: state.github.comments[url.searchParams.get('number') ?? ''] ?? [],
        status: 'connected'
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/github/issue-comments') {
      const payload = await readJson<{ body: string; number: number }>(request);
      const comment = await store.update((current) => {
        const issueComments = current.github.comments[String(payload.number)] ??= [];
        const next = {
          author: 'Hecate',
          authorAvatarUrl: localSimulationAvatarUrl,
          body: payload.body,
          createdAt: checkedAt(),
          id: current.revision + 100,
          updatedAt: checkedAt(),
          url: ''
        };
        issueComments.push(next);
        return next;
      });
      writeJson(response, 200, { comment, status: 'connected' });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/github/pipeline') {
      writeJson(response, 200, { checkedAt: checkedAt(), runs: state.github.workflowRuns, status: 'connected' });
      return;
    }
    if (method === 'GET' && /^\/api\/github\/workflow-runs\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1));
      const run = state.github.workflowRuns.find((candidate) => candidate.id === id);
      writeJson(response, 200, { checkedAt: checkedAt(), jobs: [], run, status: 'connected' });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/dev-servers/inspect') {
      writeJson(response, 200, devServerOverview(state));
      return;
    }
    if (method === 'POST' && ['/api/dev-servers/start', '/api/dev-servers/stop'].includes(url.pathname)) {
      const start = url.pathname.endsWith('/start');
      await store.update((current) => {
        current.devServer = start ? { startedAt: checkedAt(), state: 'running' } : { state: 'stopped' };
      });
      writeJson(response, 200, devServerOverview(await store.read()));
      return;
    }
    if (method === 'PUT' && url.pathname === '/api/dev-servers/settings') {
      writeJson(response, 200, devServerOverview(state));
      return;
    }
    if (method === 'GET' && url.pathname === '/api/deployed-environments/status') {
      writeJson(response, 200, {
        checkedAt: checkedAt(),
        environments: [{
          deployedSha: localSimulationIdentity.headSha,
          displayName: 'Local simulation',
          id: 'local-simulation',
          liveUrlState: 'withheld',
          sourceRef: localSimulationIdentity.branchName,
          verification: 'healthy',
          verifiedAt: checkedAt()
        }],
        repositoryFullName: repository.fullName,
        status: 'available'
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/pull-request-previews/status') {
      writeJson(response, 200, {
        checkedAt: checkedAt(),
        previews: [{
          checksStatus: 'passing', currentHeadSha: localSimulationIdentity.headSha,
          headBranch: localSimulationIdentity.branchName, isDraft: true,
          linkedIssueNumbers: [localSimulationIdentity.issueNumber], liveUrl: '/', liveUrlState: 'available',
          pullRequestNumber: localSimulationIdentity.pullRequestNumber, pullRequestState: 'open',
          pullRequestTitle: 'Add local simulation runtime', repositoryFullName: repository.fullName,
          requestedSha: localSimulationIdentity.headSha, runningSha: localSimulationIdentity.headSha,
          state: 'ready', verifiedAt: checkedAt()
        }],
        repositoryFullName: repository.fullName,
        status: 'available'
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/pull-request-previews/test-surfaces') {
      writeJson(response, 200, {
        checkedAt: checkedAt(),
        feedback: { reasonCode: 'feedback-task-missing', state: 'unavailable' },
        headSha: localSimulationIdentity.headSha,
        liveContext: { reasonCode: 'live-registration-missing', state: 'unavailable' },
        pullRequestNumber: localSimulationIdentity.pullRequestNumber,
        repositoryFullName: repository.fullName,
        surfaces: [{
          commitSha: localSimulationIdentity.headSha,
          kind: 'full-preview',
          source: 'deployed',
          state: 'available',
          url: '/',
          verifiedAt: checkedAt()
        }]
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/codex/status') {
      writeJson(response, 200, {
        appServerReachable: true, appInstalled: true, cliAvailable: true,
        codexHome: '/local-simulation/codex', configPath: '/local-simulation/codex/config.toml',
        skillsPath: '/local-simulation/codex/skills'
      });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/codex/tasks/existing') {
      const issue = Number(url.searchParams.get('issue'));
      const repositoryId = url.searchParams.get('repositoryId');
      const connectorId = url.searchParams.get('connectorId');
      const matchesRequestedTask = state.codexTask
        && state.codexTask.issue.number === issue
        && state.codexTask.repository.id === repositoryId
        && state.codexTask.connector.id === connectorId;
      writeJson(response, 200, matchesRequestedTask
        ? { action: 'continue', apiVersion: 1, state: 'confirmed', task: state.codexTask }
        : { apiVersion: 1, state: 'missing' });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/codex/tasks/start') {
      const payload = await readJson<{
        dryRun?: boolean;
        issue: number;
        model?: string;
        operationId: string;
        reasoningEffort?: string;
      }>(request);
      if (payload.dryRun !== undefined && typeof payload.dryRun !== 'boolean') {
        writeJson(response, 400, { error: 'dryRun must be a boolean.' });
        return;
      }
      const worker = normalizeCodexMachineTaskWorker(payload);
      if (!worker) {
        writeJson(response, 400, { error: 'Worker selection is invalid.' });
        return;
      }
      const { model, reasoningEffort } = worker;
      const target = {
        connector: { generation: 1, id: state.machine.id, name: state.machine.name },
        environment: { id: 'local-simulation', name: 'Local simulation' },
        physicalMachine: { id: 'local-computer', name: 'Local computer' }
      };
      if (payload.dryRun) {
        const worktree = currentWorktree(state);
        writeJson(response, 200, {
          apiVersion: 1,
          operationId: payload.operationId,
          plan: {
            base: { branch: localSimulationIdentity.branchName, commit: localSimulationIdentity.headSha },
            environment: { id: 'local-simulation', name: 'Local simulation' },
            issue: { number: payload.issue, url: `https://github.com/${repository.fullName}/issues/${payload.issue}` },
            operation: { id: payload.operationId, state: 'ready' },
            repository: { id: repository.fullName, nameWithOwner: repository.fullName },
            reportingTask: { evidence: 'caller-supplied', role: 'initiator', threadId: '61600000-0000-4000-8000-000000000002' },
            worker: { model, reasoningEffort },
            workspace: { branch: worktree.branchName, commit: worktree.headSha, id: worktree.id, path: worktree.path },
            worktree: { branch: worktree.branchName, id: worktree.id }
          },
          state: 'ready',
          target
        });
        return;
      }
      const task = await store.update((current) => {
        const worktree = currentWorktree(current);
        current.codexTask = {
          ...target,
          base: { branch: localSimulationIdentity.branchName, commit: localSimulationIdentity.headSha },
          canonicalTaskUrl: 'http://127.0.0.1/codex/local-simulation-thread',
          issue: { number: payload.issue, url: `https://github.com/${repository.fullName}/issues/${payload.issue}` },
          repository: { id: repository.fullName, nameWithOwner: repository.fullName },
          reportingTask: { evidence: 'caller-supplied', role: 'initiator', threadId: '61600000-0000-4000-8000-000000000002' },
          threadId: '61600000-0000-4000-8000-000000000001',
          worker: { model, reasoningEffort },
          workspace: { branch: worktree.branchName, commit: worktree.headSha, id: worktree.id, path: worktree.path },
          worktree: { branch: worktree.branchName, id: worktree.id }
        };
        current.codexMessages = [{
          id: 'local-simulation-welcome',
          role: 'assistant',
          sequence: (current.revision + 1) * 10,
          text: 'The local development task is ready. Provider calls and responses stay inside this simulation.'
        }];
        return current.codexTask;
      });
      writeJson(response, 200, { apiVersion: 1, operationId: payload.operationId, state: 'confirmed', task });
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/codex\/sessions\/([^/]+)(?:\/(continue|inspect|stream))?$/);
    if (sessionMatch && state.codexTask?.threadId === sessionMatch[1]) {
      const action = sessionMatch[2];
      const session = {
        activity: {
          conversationState: 'idle', currentPhase: 'Ready', currentTurnState: 'none',
          evidenceRevision: String(state.revision), freshness: 'live', lastEventAt: state.updatedAt,
          latestActivity: 'Local task ready', machineState: 'online', processState: 'ready'
        },
        archived: false,
        cwd: options.repositoryRoot,
        id: state.codexTask.threadId,
        lastActivityAt: state.updatedAt,
        loadedByProjectSpace: true,
        machineId: state.machine.id,
        machineName: state.machine.name,
        model: 'built-in-responder',
        project: repository.name,
        source: 'local-simulation',
        status: 'idle',
        taskIdentity: {
          branch: localSimulationIdentity.branchName,
          issueNumber: localSimulationIdentity.issueNumber,
          repository: repository.fullName,
          worktree: state.worktrees[0]!.id
        },
        title: 'Offline-first development runtime'
      };
      if (method === 'GET' && !action) {
        const messages = state.codexMessages?.length ? state.codexMessages : [{
          id: 'local-simulation-welcome',
          role: 'assistant' as const,
          text: 'The local development task is ready. Provider calls and responses stay inside this simulation.'
        }];
        writeJson(response, 200, {
          openedReadOnly: true,
          permissionProfileId: 'local-safe',
          permissionProfiles: [{ allowed: true, description: 'Stateful local adapters only', id: 'local-safe' }],
          session,
          streamCursor: state.revision * 10,
          turns: messages.map((message, index) => ({
            completedAt: state.updatedAt,
            id: `local-turn-${index + 1}`,
            items: [{ id: message.id, kind: message.role === 'user' ? 'user-message' : 'agent-message', status: 'completed', text: message.text }],
            startedAt: state.updatedAt,
            status: 'completed'
          }))
        });
        return;
      }
      if (method === 'GET' && action === 'inspect') {
        writeJson(response, 200, {
          checkedAt: checkedAt(), openedReadOnly: true, session,
          sessionRevision: String(state.revision),
          taskLocation: {
            canonicalCwd: options.repositoryRoot, checkedAt: checkedAt(), machineId: state.machine.id,
            sessionRevision: String(state.revision), source: 'connector-realpath',
            threadId: state.codexTask.threadId, worktreeRoot: options.repositoryRoot
          },
          writeCapability: {
            canContinue: true, checkedAt: checkedAt(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
            machineId: state.machine.id, sessionLastActivityAt: state.updatedAt,
            sessionRevision: String(state.revision), state: 'ready', threadId: state.codexTask.threadId
          }
        });
        return;
      }
      if (method === 'GET' && action === 'stream') {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/event-stream');
        const afterSequence = Number(request.headers['last-event-id'] ?? url.searchParams.get('afterSequence') ?? 0);
        for (const message of state.codexMessages ?? []) {
          const sequence = message.sequence ?? 0;
          if (sequence <= afterSequence) continue;
          response.write(`id: ${sequence}\ndata: ${JSON.stringify({
            eventId: String(sequence),
            item: {
              id: message.id,
              kind: message.role === 'user' ? 'user-message' : 'agent-message',
              status: 'completed',
              text: message.text
            },
            turnId: `local-turn-${Math.floor(sequence / 10)}`,
            type: 'item'
          })}\n\n`);
        }
        const statusSequence = state.revision * 10 + 9;
        response.write(`id: ${statusSequence}\ndata: ${JSON.stringify({ eventId: String(statusSequence), status: 'idle', type: 'session-status' })}\n\n`);
        response.end();
        return;
      }
      if (method === 'POST' && action === 'continue') {
        const payload = await readJson<{ message: string; operationId: string }>(request);
        await store.update((current) => {
          const messages = current.codexMessages ??= [];
          const nextSequence = (current.revision + 1) * 10;
          messages.push({ id: `local-user-${current.revision}`, role: 'user', sequence: nextSequence + 1, text: payload.message });
          messages.push({ id: `local-agent-${current.revision}`, role: 'assistant', sequence: nextSequence + 2, text: 'Local simulation received the message and preserved it without contacting an external model.' });
        });
        writeJson(response, 200, {
          operationId: payload.operationId, replayed: false, status: 'completed',
          threadId: state.codexTask.threadId, turnId: `local-turn-${state.revision}`
        });
        return;
      }
    }
    if (method === 'GET' && url.pathname === '/api/codex/sessions') {
      const task = state.codexTask;
      writeJson(response, 200, {
        checkedAt: checkedAt(),
        inventoryState: 'live',
        machine: { id: state.machine.id, name: state.machine.name, online: true },
        publishedAt: checkedAt(),
        sessions: task ? [{
          activity: {
            conversationState: 'idle', currentPhase: 'Ready', currentTurnState: 'none',
            evidenceRevision: String(state.revision), freshness: 'live', lastEventAt: state.updatedAt,
            latestActivity: 'Local task ready', machineState: 'online', processState: 'ready'
          },
          archived: false,
          cwd: options.repositoryRoot,
          id: task.threadId,
          lastActivityAt: state.updatedAt,
          loadedByProjectSpace: true,
          machineId: state.machine.id,
          machineName: state.machine.name,
          model: 'built-in-responder',
          project: repository.name,
          source: 'local-simulation',
          status: 'idle',
          taskIdentity: {
            branch: localSimulationIdentity.branchName,
            issueNumber: localSimulationIdentity.issueNumber,
            repository: repository.fullName,
            worktree: state.worktrees[0]!.id
          },
          title: 'Offline-first development runtime'
        }] : []
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/machines/terminal/run') {
      const payload = await readJson<{ command: string; machineId: string }>(request);
      const isMetadataProbe = payload.command.includes('__PS_META__');
      const selectedWorktree = state.worktrees.find((worktree) => payload.command.includes(worktree.path));
      writeJson(response, 200, {
        command: payload.command, cwd: options.repositoryRoot, durationMs: 1,
        exitCode: isMetadataProbe ? 0 : 2,
        stderr: isMetadataProbe ? '' : 'This terminal command is not implemented by the local simulation.',
        stdout: isMetadataProbe
          ? `__PS_META__\t${selectedWorktree?.path ?? options.repositoryRoot}\t${selectedWorktree?.branchName ?? localSimulationIdentity.branchName}\t\n`
          : ''
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/machines/filesystem/directory') {
      const payload = await readJson<{ path: string }>(request);
      writeJson(response, 200, {
        entries: [
          { kind: 'file', name: 'README.md', path: `${payload.path}/README.md`, sizeBytes: 616 },
          { kind: 'directory', name: 'server', path: `${payload.path}/server` },
          { kind: 'directory', name: 'src', path: `${payload.path}/src` }
        ],
        path: payload.path,
        status: 'success'
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/machines/filesystem/file') {
      const payload = await readJson<{ path: string }>(request);
      writeJson(response, 200, {
        content: '# Project Space\n\nThis file is supplied by the local simulation.',
        name: payload.path.split('/').at(-1) ?? 'README.md', path: payload.path,
        sizeBytes: 64, status: 'success'
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/git/history') {
      writeJson(response, 200, {
        commits: [{
          author: 'Hecate', date: state.updatedAt, hash: localSimulationIdentity.headSha,
          parents: ['831e68d4eb68138d41abf6f8459c97f00ca8a74e'],
          refs: [`HEAD -> ${localSimulationIdentity.branchName}`], subject: 'Add local simulation runtime'
        }],
        cwd: options.repositoryRoot, isRepository: true, repositoryRoot: options.repositoryRoot
      });
      return;
    }
    if (method === 'POST' && url.pathname === '/api/git/diff') {
      writeJson(response, 200, { diff: '', staged: false });
      return;
    }
    if (method === 'GET' && url.pathname === '/api/launcher/apps') {
      writeJson(response, 200, []);
      return;
    }
    if (method === 'GET' && url.pathname === '/api/auth/session') {
      writeJson(response, 200, { authenticated: true, user: { email: 'local@simulation.invalid', id: 'local-developer', name: 'Local developer' } });
      return;
    }

    writeJson(response, 501, { error: 'This action is not available in the current local simulation scenario.' });
  };
}
