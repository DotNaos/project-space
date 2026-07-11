import type {
  DevServerActionRequest,
  DevServerConnectorResult,
  DevServerInspectRequest,
  DevServerOverviewResult,
  DevServerState,
  MachineMembershipAccess,
  ProjectRunSettingsRecord,
  ProjectRunSettingsUpdateRequest,
  ProjectSpaceBackend,
  ProjectWorktreeRecord,
  WorktreeDevServerRecord
} from '../src/shared/project-space-api';
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
  validateConnectorResult,
  type ConnectorActor,
  type ConnectorExecutionRequest
} from './dev-server-validation';

export interface DevServerConnectorGateway {
  inspect(request: ConnectorExecutionRequest, actor: ConnectorActor): Promise<DevServerConnectorResult>;
  start(request: ConnectorExecutionRequest, actor: ConnectorActor): Promise<DevServerConnectorResult>;
  stop(request: ConnectorExecutionRequest, actor: ConnectorActor): Promise<DevServerConnectorResult>;
}

export interface DevServerDatabaseGateway {
  createDevServerSession(input: {
    localPort?: number;
    machineId: string;
    ownerUserId: string;
    projectId: string;
    runTarget?: string;
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
      worktreeId?: string;
    }
  ): Promise<DevServerSession[]>;
  readMachineMembership(input: { machineId: string; userId: string }): Promise<MachineMembership | null>;
  readProjectRunSettings(input: {
    machineId: string;
    projectId: string;
    userId: string;
  }): Promise<ProjectRunSettings | null>;
  transitionDevServerSession(input: TransitionDevServerSessionInput): Promise<DevServerSession | null>;
  upsertProjectRunSettings(input: UpsertProjectRunSettingsInput): Promise<ProjectRunSettings>;
}

export interface DevServerServiceOptions {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview' | 'loadProjectDiscovery' | 'loadProjectWorktrees'>;
  connector: DevServerConnectorGateway;
  database: DevServerDatabaseGateway;
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
    lastError: record.state === 'error' ? record.lastError ?? 'Development server failed.' : null,
    lastSeenAt: checkedAt(now),
    localPort: record.localPort ?? null,
    sessionId: session.id,
    startedAt: record.startedAt ?? null,
    state: record.state,
    stoppedAt: record.state === 'stopped' ? checkedAt(now) : null,
    tailscalePort: record.publicPort ?? null,
    tailscaleUrl: record.state === 'running' ? record.tailscaleUrl ?? null : null,
    userId
  };
}

export function createDevServerService(options: DevServerServiceOptions) {
  const now = options.now ?? (() => new Date());
  const lockTails = new Map<string, Promise<void>>();

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

  async function resolveProjectScope(
    machineScope: ResolvedMachineScope
  ): Promise<ResolvedScope> {
    const discovery = await options.backend.loadProjectDiscovery();
    const project = discovery.projects.find(
      (candidate) =>
        candidate.id === machineScope.projectId &&
        candidate.machineId === machineScope.machineId
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
    if (!worktree || worktree.status !== 'ready') {
      throw new Error('The selected worktree is not available on this machine.');
    }

    return { ...scope, worktree };
  }

  async function accessFor(userId: string, machineId: string): Promise<MachineMembershipAccess> {
    if (!options.database.isConfigured()) {
      return 'database-required';
    }
    const membership = await options.database.readMachineMembership({ machineId, userId });
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
      : {
          allowedHosts: [],
          machineId: scope.machineId,
          projectId: scope.projectId,
          runTarget: 'dev'
        } satisfies ProjectRunSettingsRecord;
  }

  async function latestSession(userId: string, target: ResolvedTarget) {
    const sessions = await options.database.listDevServerSessions(userId, {
      machineId: target.machineId,
      projectId: target.projectId,
      worktreeId: target.worktree.id
    });
    return sessions.find((session) =>
      session.state === 'starting' || session.state === 'running' || session.state === 'stopping'
    ) ?? sessions[0];
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
          state: record.state,
          tailscalePort: record.publicPort,
          tailscaleUrl: record.tailscaleUrl,
          worktreeId: target.worktree.id
        });
      } catch {
        session = await latestSession(userId, target);
      }
    }
    if (!session) {
      return undefined;
    }
    return options.database.transitionDevServerSession(transitionInput(session, record, userId, now));
  }

  function executionRequest(
    target: ResolvedTarget,
    settings: ProjectRunSettingsRecord
  ): ConnectorExecutionRequest {
    return {
      allowedHosts: normalizeAllowedHosts(settings.allowedHosts),
      machineId: target.machineId,
      projectId: target.projectId,
      runTarget: normalizeRunTarget(settings.runTarget),
      worktreeId: target.worktree.id,
      worktreePath: target.worktree.path
    };
  }

  async function inspectOne(
    userId: string,
    target: ResolvedTarget,
    settings: ProjectRunSettingsRecord
  ) {
    const request = executionRequest(target, settings);
    const key = `worktree\u0000${userId}\u0000${target.machineId}\u0000${target.worktree.id}`;
    return runExclusive(key, async () => {
      const session = await latestSession(userId, target);
      const actor = { generation: session?.generation ?? 0, userId };
      try {
        const raw = await options.connector.inspect(request, actor);
        const result = validateConnectorResult(raw, request, actor, now);
        const record = recordFromResult(result, request, now);
        await persistRecord(userId, target, record, session);
        return record;
      } catch (error) {
        const record = recordFromFailure(request, error, now);
        if (session) {
          await persistRecord(userId, target, record, session);
        }
        return record;
      }
    });
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
    const readyWorktrees = worktrees.filter((worktree) => worktree.status === 'ready');
    const servers = await Promise.all(
      readyWorktrees.map((worktree) => inspectOne(userId, { ...scope, worktree }, settings))
    );
    return {
      access,
      machineId: scope.machineId,
      projectId: scope.projectId,
      servers,
      settings
    };
  }

  async function prepareMutationSession(
    userId: string,
    target: ResolvedTarget,
    state: 'starting' | 'stopping',
    runTarget: string
  ) {
    const existing = await latestSession(userId, target);
    if (!existing) {
      return options.database.createDevServerSession({
        machineId: target.machineId,
        ownerUserId: userId,
        projectId: target.projectId,
        runTarget,
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
      (await latestSession(userId, target)) ??
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
    const projectKey = `project\u0000${userId}\u0000${target.machineId}\u0000${target.projectId}`;
    const worktreeKey = `worktree\u0000${userId}\u0000${target.machineId}\u0000${target.worktree.id}`;
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

        const connectorRequest = executionRequest(target, settings);
        const session = await prepareMutationSession(
          userId,
          target,
          operation === 'start' ? 'starting' : 'stopping',
          settings.runTarget
        );
        const actor = { generation: session.generation, userId };
        try {
          const raw = await options.connector[operation](connectorRequest, actor);
          const result = validateConnectorResult(raw, connectorRequest, actor, now);
          await persistRecord(
            userId,
            target,
            recordFromResult(result, connectorRequest, now),
            session
          );
        } catch (error) {
          await persistRecord(
            userId,
            target,
            recordFromFailure(connectorRequest, error, now),
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
    const runTarget = normalizeRunTarget(request.runTarget);
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
        runTarget !== currentSettings.runTarget ||
        allowedHosts.length !== currentSettings.allowedHosts.length ||
        allowedHosts.some((host, index) => host !== currentSettings.allowedHosts[index]);
      if (settingsChanged) {
        const activeSessions = await options.database.listDevServerSessions(userId, {
          activeOnly: true,
          machineId: scope.machineId,
          projectId: scope.projectId
        });
        if (activeSessions.length > 0) {
          throw new Error(
            'Stop active development servers before changing project run settings.'
          );
        }
      }
      return mapSettings(
        await options.database.upsertProjectRunSettings({
          allowedHosts,
          machineId: scope.machineId,
          preferredWorktreeId: request.preferredWorktreeId ?? null,
          projectId: scope.projectId,
          runTarget,
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
