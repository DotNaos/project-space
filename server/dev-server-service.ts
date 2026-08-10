import type {
  DevServerActionRequest,
  DevServerConnectorResult,
  DevServerInspectRequest,
  DevServerListConnectorResult,
  DevServerOverviewResult,
  DevServerState,
  MachineMembershipAccess,
  ProjectRunSettingsRecord,
  ProjectRunSettingsUpdateRequest,
  ProjectSpaceBackend,
  ProjectWorktreeRecord,
  WorktreeDevServerRecord
} from '../src/shared/project-space-api';
import { DEV_SERVER_DECLARATION_MISSING_MESSAGE } from '../src/shared/dev-server-api';
import type {
  DevServerSession,
  MachineMembership,
  ProjectRunSettings,
  TransitionDevServerSessionInput,
  UpsertProjectRunSettingsInput
} from './local-database-store';
import {
  checkedAt,
  normalizeAllowedHosts,
  normalizeRunTarget,
  recordFromFailure,
  recordFromResult,
  requireIdentifier,
  validateConnectorListResult,
  validateConnectorResult,
  type ConnectorActor,
  type ConnectorExecutionRequest,
  type ConnectorListExecutionRequest
} from './dev-server-validation';

export interface DevServerConnectorGateway {
  list(
    request: ConnectorListExecutionRequest,
    actor: ConnectorActor
  ): Promise<DevServerListConnectorResult>;
  inspect(
    request: ConnectorExecutionRequest,
    actor: ConnectorActor
  ): Promise<DevServerConnectorResult>;
  start(
    request: ConnectorExecutionRequest,
    actor: ConnectorActor
  ): Promise<DevServerConnectorResult>;
  stop(
    request: ConnectorExecutionRequest,
    actor: ConnectorActor
  ): Promise<DevServerConnectorResult>;
}

export interface DevServerDatabaseGateway {
  createDevServerSession(input: {
    localPort?: number;
    machineId: string;
    ownerUserId: string;
    projectId: string;
    runTarget?: string;
    serverId: string;
    state?: DevServerState;
    tailscalePort?: number;
    tailscaleUrl?: string;
    worktreeId: string;
  }): Promise<DevServerSession>;
  isConfigured(): boolean;
  isMachineClaimed(machineId: string): Promise<boolean>;
  listDevServerSessions(
    userId: string,
    filter?: {
      activeOnly?: boolean;
      machineId?: string;
      projectId?: string;
      serverId?: string;
      worktreeId?: string;
    }
  ): Promise<DevServerSession[]>;
  readMachineMembership(input: {
    machineId: string;
    userId: string;
  }): Promise<MachineMembership | null>;
  readProjectRunSettings(input: {
    machineId: string;
    projectId: string;
    userId: string;
  }): Promise<ProjectRunSettings | null>;
  transitionDevServerSession(
    input: TransitionDevServerSessionInput
  ): Promise<DevServerSession | null>;
  upsertProjectRunSettings(input: UpsertProjectRunSettingsInput): Promise<ProjectRunSettings>;
}

export interface DevServerServiceOptions {
  backend: Pick<
    ProjectSpaceBackend,
    'getConnectorOverview' | 'loadProjectDiscovery' | 'loadProjectWorktrees'
  >;
  connector: DevServerConnectorGateway;
  database: DevServerDatabaseGateway;
  inspectConcurrency?: number;
  now?: () => Date;
  userId(): string;
}

interface ResolvedScope {
  machineId: string;
  projectId: string;
  projectPath: string;
}

interface ResolvedMachineScope {
  machineId: string;
  projectId: string;
}

interface ResolvedTarget extends ResolvedScope {
  worktree: ProjectWorktreeRecord;
}

const missingDevServerDeclarationConnectorError =
  'project scripts are not configured: missing .project/scripts.yaml';

class MissingDevServerDeclarationError extends Error {
  constructor() {
    super(DEV_SERVER_DECLARATION_MISSING_MESSAGE);
  }
}

function mapSettings(settings: ProjectRunSettings): ProjectRunSettingsRecord {
  return {
    allowedHosts: normalizeAllowedHosts(settings.allowedHosts),
    machineId: settings.machineId,
    preferredWorktreeId: settings.preferredWorktreeId,
    projectId: settings.projectId,
    runTarget: normalizeRunTarget(settings.runTarget)
  };
}

function transitionInput(
  session: DevServerSession,
  record: WorktreeDevServerRecord,
  userId: string,
  now: () => Date
): TransitionDevServerSessionInput {
  return {
    expectedGeneration: session.generation,
    lastError: record.state === 'error' ? (record.lastError ?? 'Development server failed.') : null,
    lastSeenAt: checkedAt(now),
    localPort: record.localPort ?? null,
    sessionId: session.id,
    startedAt: record.startedAt ?? null,
    state: record.state,
    stoppedAt: record.state === 'stopped' ? checkedAt(now) : null,
    tailscalePort: record.publicPort ?? null,
    tailscaleUrl: record.state === 'running' ? (record.tailscaleUrl ?? null) : null,
    userId
  };
}

export function createDevServerService(options: DevServerServiceOptions) {
  const now = options.now ?? (() => new Date());
  const lockTails = new Map<string, Promise<void>>();
  const inspectConcurrency = options.inspectConcurrency ?? 8;
  if (
    !Number.isSafeInteger(inspectConcurrency) ||
    inspectConcurrency < 1 ||
    inspectConcurrency > 32
  ) {
    throw new Error('Development-server inspect concurrency must be between 1 and 32.');
  }
  let activeInspections = 0;
  const inspectionWaiters: Array<() => void> = [];

  async function withInspectionSlot<T>(action: () => Promise<T>) {
    if (activeInspections >= inspectConcurrency) {
      await new Promise<void>((resolve) => inspectionWaiters.push(resolve));
    } else {
      activeInspections++;
    }
    try {
      return await action();
    } finally {
      const next = inspectionWaiters.shift();
      if (next) next();
      else activeInspections--;
    }
  }

  async function runExclusive<T>(key: string, action: () => Promise<T>) {
    const previous = lockTails.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    lockTails.set(key, tail);
    await previous.catch(() => undefined);

    try {
      return await action();
    } finally {
      release();
      if (lockTails.get(key) === tail) {
        lockTails.delete(key);
      }
    }
  }

  async function resolveMachineScope(
    request: DevServerInspectRequest
  ): Promise<ResolvedMachineScope> {
    const machineId = requireIdentifier(request.machineId, 'machineId', 256);
    const projectId = requireIdentifier(request.projectId, 'projectId');
    const connectorOverview = await options.backend.getConnectorOverview();
    const machine = connectorOverview.machines.find((candidate) => candidate.id === machineId);
    if (!machine) {
      throw new Error('The selected machine is not registered.');
    }
    if (machine.connector.status !== 'local' && machine.connector.status !== 'online') {
      throw new Error('The selected machine connector is offline.');
    }

    return { machineId, projectId };
  }

  async function resolveProjectScope(machineScope: ResolvedMachineScope): Promise<ResolvedScope> {
    const discovery = await options.backend.loadProjectDiscovery();
    const project = discovery.projects.find(
      (candidate) =>
        candidate.id === machineScope.projectId && candidate.machineId === machineScope.machineId
    );
    if (!project) {
      throw new Error('The selected project is not registered.');
    }
    return {
      ...machineScope,
      projectPath: project.rootPath
    };
  }

  async function resolveWorktrees(scope: ResolvedScope) {
    return options.backend.loadProjectWorktrees(scope.projectPath, scope.machineId);
  }

  async function resolveTarget(
    scope: ResolvedScope,
    worktreeIdValue: string
  ): Promise<ResolvedTarget> {
    const worktreeId = requireIdentifier(worktreeIdValue, 'worktreeId', 2_048);
    const worktrees = await resolveWorktrees(scope);
    const worktree = worktrees.find((candidate) => candidate.id === worktreeId);
    if (!worktree || worktree.status !== 'ready' || !worktree.headSha) {
      throw new Error('The selected worktree is not available on this machine.');
    }

    return { ...scope, worktree };
  }

  async function accessFor(userId: string, machineId: string): Promise<MachineMembershipAccess> {
    if (!options.database.isConfigured()) {
      return 'database-required';
    }
    const membership = await options.database.readMachineMembership({
      machineId,
      userId
    });
    if (membership) {
      return membership.role;
    }
    return (await options.database.isMachineClaimed(machineId)) ? 'denied' : 'unclaimed';
  }

  async function settingsFor(userId: string, scope: ResolvedScope) {
    const stored = await options.database.readProjectRunSettings({
      machineId: scope.machineId,
      projectId: scope.projectId,
      userId
    });
    return stored
      ? mapSettings(stored)
      : ({
          allowedHosts: [],
          machineId: scope.machineId,
          projectId: scope.projectId,
          runTarget: 'dev'
        } satisfies ProjectRunSettingsRecord);
  }

  async function latestSession(userId: string, target: ResolvedTarget, serverId: string) {
    const sessions = await options.database.listDevServerSessions(userId, {
      machineId: target.machineId,
      projectId: target.projectId,
      serverId,
      worktreeId: target.worktree.id
    });
    return (
      sessions.find(
        (session) =>
          session.state === 'starting' ||
          session.state === 'running' ||
          session.state === 'stopping'
      ) ?? sessions[0]
    );
  }

  async function persistRecord(
    userId: string,
    target: ResolvedTarget,
    record: WorktreeDevServerRecord,
    existing?: DevServerSession
  ) {
    let session = existing;
    if (!session && record.state !== 'stopped') {
      try {
        session = await options.database.createDevServerSession({
          localPort: record.localPort,
          machineId: target.machineId,
          ownerUserId: userId,
          projectId: target.projectId,
          runTarget: record.runTarget,
          serverId: record.serverId,
          state: record.state,
          tailscalePort: record.publicPort,
          tailscaleUrl: record.tailscaleUrl,
          worktreeId: target.worktree.id
        });
      } catch {
        session = await latestSession(userId, target, record.serverId);
      }
    }
    if (!session) {
      return undefined;
    }
    return options.database.transitionDevServerSession(
      transitionInput(session, record, userId, now)
    );
  }

  function executionRequest(
    target: ResolvedTarget,
    settings: ProjectRunSettingsRecord,
    serverId: string
  ): ConnectorExecutionRequest {
    return {
      allowedHosts: normalizeAllowedHosts(settings.allowedHosts),
      expectedHeadSha: target.worktree.headSha!,
      machineId: target.machineId,
      projectId: target.projectId,
      runTarget: serverId,
      serverId,
      worktreeId: target.worktree.id
    };
  }

  async function inspectOne(
    userId: string,
    target: ResolvedTarget,
    settings: ProjectRunSettingsRecord,
    server: { label: string; serverId: string }
  ) {
    const request = executionRequest(target, settings, server.serverId);
    const key = `server\u0000${userId}\u0000${target.machineId}\u0000${target.worktree.id}\u0000${server.serverId}`;
    return runExclusive(key, async () => {
      const session = await latestSession(userId, target, server.serverId);
      const actor = { generation: session?.generation ?? 0, userId };
      try {
        const raw = await withInspectionSlot(() => options.connector.inspect(request, actor));
        const result = validateConnectorResult(raw, request, actor, now);
        const record = recordFromResult(result, request, now, server.label);
        await persistRecord(userId, target, record, session);
        return record;
      } catch (error) {
        const record = recordFromFailure(request, error, now, server.label);
        if (session) {
          await persistRecord(userId, target, record, session);
        }
        return record;
      }
    });
  }

  async function listConfiguredServers(target: ResolvedTarget, userId: string) {
    const request: ConnectorListExecutionRequest = {
      expectedHeadSha: target.worktree.headSha!,
      machineId: target.machineId,
      projectId: target.projectId,
      worktreeId: target.worktree.id
    };
    const actor = { generation: 0, userId };
    const result = validateConnectorListResult(
      await withInspectionSlot(() => options.connector.list(request, actor)),
      request,
      actor,
      now
    );
    if (result.capability === 'unavailable') {
      if (
        result.servers.length === 0 &&
        result.lastError === missingDevServerDeclarationConnectorError
      ) {
        throw new MissingDevServerDeclarationError();
      }
      throw new Error('Development-server inventory is unavailable.');
    }
    return result.servers;
  }

  async function inspect(request: DevServerInspectRequest): Promise<DevServerOverviewResult> {
    const userId = requireIdentifier(options.userId(), 'authenticated user', 256);
    const machineScope = await resolveMachineScope(request);
    const access = await accessFor(userId, machineScope.machineId);
    if (access !== 'owner' && access !== 'member') {
      return {
        access,
        machineId: machineScope.machineId,
        message:
          access === 'database-required'
            ? 'Configure DATABASE_URL before using per-user development servers.'
            : access === 'unclaimed'
              ? 'Install this connector from your account to enroll the machine.'
              : 'This machine is assigned to another Project Space account.',
        projectId: machineScope.projectId,
        servers: []
      };
    }
    const scope = await resolveProjectScope(machineScope);

    const [settings, worktrees] = await Promise.all([
      settingsFor(userId, scope),
      resolveWorktrees(scope)
    ]);
    const branchName = request.branchName === undefined
      ? undefined
      : requireIdentifier(request.branchName, 'branchName', 2_048);
    const preferBase = request.preferBase === true;
    const requestedWorktreeIds = request.worktreeIds?.map((worktreeId) =>
      requireIdentifier(worktreeId, 'worktreeId', 2_048)
    );
    const selectorCount = Number(Boolean(requestedWorktreeIds)) + Number(Boolean(branchName)) + Number(preferBase);
    if (selectorCount > 1) {
      throw new Error('Choose only one development-server worktree selector.');
    }
    if (requestedWorktreeIds && requestedWorktreeIds.length > 32) {
      throw new Error('Development-server inspection supports at most 32 worktrees.');
    }
    const requestedWorktreeIdSet = requestedWorktreeIds
      ? new Set(requestedWorktreeIds)
      : undefined;
    if (requestedWorktreeIdSet && requestedWorktreeIdSet.size !== requestedWorktreeIds!.length) {
      throw new Error('Development-server worktree identities must be unique.');
    }
    const readyWorktrees = worktrees.filter(
      (worktree) =>
        worktree.status === 'ready' &&
        (!requestedWorktreeIdSet || requestedWorktreeIdSet.has(worktree.id)) &&
        (!branchName || worktree.branchName === branchName) &&
        (!preferBase || worktree.isBase)
    );
    if (requestedWorktreeIdSet && readyWorktrees.length !== requestedWorktreeIdSet.size) {
      throw new Error('A requested worktree is not available on this machine.');
    }
    if ((branchName || preferBase) && readyWorktrees.length !== 1) {
      throw new Error('The selected development-server worktree is not available on this machine.');
    }
    const inventories = await Promise.allSettled(
      readyWorktrees.map(async (worktree) => {
        const target = { ...scope, worktree };
        const configured = await listConfiguredServers(target, userId);
        return Promise.all(
          configured.map((server) => inspectOne(userId, target, settings, server))
        );
      })
    );
    const servers = inventories.flatMap((inventory) =>
      inventory.status === 'fulfilled' ? inventory.value : []
    );
    const missingDeclarationInventories = inventories.filter(
      (inventory) =>
        inventory.status === 'rejected' &&
        inventory.reason instanceof MissingDevServerDeclarationError
    );
    const failedInventories = inventories.filter(
      (inventory) =>
        inventory.status === 'rejected' &&
        !(inventory.reason instanceof MissingDevServerDeclarationError)
    );
    return {
      access,
      machineId: scope.machineId,
      ...(failedInventories.length > 0
        ? {
            message: `Could not read development-server declarations for ${failedInventories.length} worktree${failedInventories.length === 1 ? '' : 's'}.`
          }
        : missingDeclarationInventories.length > 0
          ? { message: DEV_SERVER_DECLARATION_MISSING_MESSAGE }
          : {}),
      projectId: scope.projectId,
      servers,
      settings
    };
  }

  async function prepareMutationSession(
    userId: string,
    target: ResolvedTarget,
    state: 'starting' | 'stopping',
    serverId: string
  ) {
    const existing = await latestSession(userId, target, serverId);
    if (!existing) {
      return options.database.createDevServerSession({
        machineId: target.machineId,
        ownerUserId: userId,
        projectId: target.projectId,
        runTarget: serverId,
        serverId,
        state,
        worktreeId: target.worktree.id
      });
    }
    if (existing.state === state || (state === 'starting' && existing.state === 'running')) {
      return existing;
    }
    return (
      (await options.database.transitionDevServerSession({
        expectedGeneration: existing.generation,
        sessionId: existing.id,
        state,
        userId
      })) ??
      (await latestSession(userId, target, serverId)) ??
      existing
    );
  }

  async function mutate(
    operation: 'start' | 'stop',
    request: DevServerActionRequest
  ): Promise<DevServerOverviewResult> {
    const userId = requireIdentifier(options.userId(), 'authenticated user', 256);
    const machineScope = await resolveMachineScope(request);
    const access = await accessFor(userId, machineScope.machineId);
    if (access !== 'owner' && access !== 'member') {
      return {
        access,
        machineId: machineScope.machineId,
        message: 'You do not have access to this machine.',
        projectId: machineScope.projectId,
        servers: []
      };
    }
    const scope = await resolveProjectScope(machineScope);
    const target = await resolveTarget(scope, request.worktreeId);
    const serverId = normalizeRunTarget(requireIdentifier(request.serverId, 'serverId', 64));
    const configuredServers = await listConfiguredServers(target, userId);
    const configuredServer = configuredServers.find((server) => server.serverId === serverId);
    if (!configuredServer || configuredServer.capability !== 'configured') {
      throw new Error('The selected development server is not declared in this worktree.');
    }
    const projectKey = `project\u0000${userId}\u0000${target.machineId}\u0000${target.projectId}`;
    const worktreeKey = `server\u0000${userId}\u0000${target.machineId}\u0000${target.worktree.id}\u0000${serverId}`;
    await runExclusive(projectKey, async () => {
      await runExclusive(worktreeKey, async () => {
        let settings = await settingsFor(userId, target);
        if (operation === 'start') {
          settings = mapSettings(
            await options.database.upsertProjectRunSettings({
              allowedHosts: settings.allowedHosts,
              machineId: target.machineId,
              preferredWorktreeId: target.worktree.id,
              projectId: target.projectId,
              runTarget: settings.runTarget,
              userId
            })
          );
        }

        const connectorRequest = executionRequest(target, settings, serverId);
        const session = await prepareMutationSession(
          userId,
          target,
          operation === 'start' ? 'starting' : 'stopping',
          serverId
        );
        const actor = { generation: session.generation, userId };
        try {
          const raw = await options.connector[operation](connectorRequest, actor);
          const result = validateConnectorResult(raw, connectorRequest, actor, now);
          await persistRecord(
            userId,
            target,
            recordFromResult(result, connectorRequest, now, configuredServer.label),
            session
          );
        } catch (error) {
          await persistRecord(
            userId,
            target,
            recordFromFailure(connectorRequest, error, now, configuredServer.label),
            session
          );
          throw error;
        }
      });
    });

    return inspect(request);
  }

  async function updateSettings(request: ProjectRunSettingsUpdateRequest) {
    const userId = requireIdentifier(options.userId(), 'authenticated user', 256);
    const machineScope = await resolveMachineScope(request);
    const access = await accessFor(userId, machineScope.machineId);
    if (access !== 'owner' && access !== 'member') {
      throw new Error('You do not have access to this machine.');
    }
    const scope = await resolveProjectScope(machineScope);
    const allowedHosts = normalizeAllowedHosts(request.allowedHosts);
    if (request.preferredWorktreeId) {
      const worktrees = await resolveWorktrees(scope);
      if (!worktrees.some((worktree) => worktree.id === request.preferredWorktreeId)) {
        throw new Error('The preferred worktree is not registered on this machine.');
      }
    }
    const projectKey = `project\u0000${userId}\u0000${scope.machineId}\u0000${scope.projectId}`;
    return runExclusive(projectKey, async () => {
      const currentSettings = await settingsFor(userId, scope);
      const settingsChanged =
        allowedHosts.length !== currentSettings.allowedHosts.length ||
        allowedHosts.some((host, index) => host !== currentSettings.allowedHosts[index]);
      if (settingsChanged) {
        const activeSessions = await options.database.listDevServerSessions(userId, {
          activeOnly: true,
          machineId: scope.machineId,
          projectId: scope.projectId
        });
        if (activeSessions.length > 0) {
          throw new Error('Stop active development servers before changing project run settings.');
        }
      }
      return mapSettings(
        await options.database.upsertProjectRunSettings({
          allowedHosts,
          machineId: scope.machineId,
          preferredWorktreeId: request.preferredWorktreeId ?? null,
          projectId: scope.projectId,
          runTarget: currentSettings.runTarget,
          userId
        })
      );
    });
  }

  return {
    inspect,
    start(request: DevServerActionRequest) {
      return mutate('start', request);
    },
    stop(request: DevServerActionRequest) {
      return mutate('stop', request);
    },
    updateSettings
  };
}
