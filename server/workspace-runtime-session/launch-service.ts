import { workspaceRuntimeCapabilities } from '../../src/shared/workspace-runtime-session-api';
import type {
  SshGatewayActor,
  SshGatewayExecutionResult,
  SshGatewayRequest
} from '../ssh-control-gateway/contracts';
import type { RuntimeSessionStore } from './contracts';

export interface WorkspaceRuntimeStartAuthority {
  branch: string;
  commit: string;
  environmentId: string;
  generation: string;
  manifestDigest: string;
  mode: 'process' | 'devcontainer';
  operationId: string;
  ownerUserId: string;
  runtimeVersion: string;
  workspaceId: string;
}

export interface WorkspaceRuntimeStartDispatch {
  environmentId: string;
  expectedCommit: string;
  expectedGeneration: string;
  expectedManifestDigest: string;
  mode: WorkspaceRuntimeStartAuthority['mode'];
  operation: 'workspace-runtime.start.v1';
  operationId: string;
  ownerUserId: string;
  runtimeSessionCapabilities: string[];
  runtimeSessionEndpoint: string;
  runtimeSessionExpiresAt: string;
  runtimeSessionToken: string;
  runtimeSessionVersion: string;
  workspaceId: string;
}

export interface WorkspaceRuntimeStartResult {
  checkedAt: string;
  generation: string;
  manifestDigest: string;
  operation: 'workspace-runtime.start.v1';
  operationId: string;
  sourceHead: string;
  state: 'running';
  workspaceId: string;
}

export interface WorkspaceRuntimeStartDispatcher {
  start(input: WorkspaceRuntimeStartDispatch): Promise<WorkspaceRuntimeStartResult>;
}

export interface WorkspaceRuntimeSshGateway {
  execute(actor: SshGatewayActor, request: SshGatewayRequest): Promise<SshGatewayExecutionResult>;
}

export class WorkspaceRuntimeSshStartDispatcher implements WorkspaceRuntimeStartDispatcher {
  constructor(
    private readonly gateway: WorkspaceRuntimeSshGateway,
    private readonly actor: SshGatewayActor
  ) {}

  async start(input: WorkspaceRuntimeStartDispatch): Promise<WorkspaceRuntimeStartResult> {
    if (input.ownerUserId !== this.actor.ownerUserId) {
      throw new Error('Workspace Runtime launch owner changed.');
    }
    const execution = await this.gateway.execute(this.actor, input);
    const result = execution.result;
    if (result.operation !== 'workspace-runtime.start.v1' || result.state !== 'running' ||
      result.generation === undefined) {
      throw new Error('Workspace Runtime SSH result is incompatible.');
    }
    return {
      checkedAt: result.checkedAt,
      generation: result.generation,
      manifestDigest: result.manifestDigest,
      operation: result.operation,
      operationId: result.operationId,
      sourceHead: result.sourceHead,
      state: result.state,
      workspaceId: result.workspaceId
    };
  }
}

export class WorkspaceRuntimeLaunchService {
  constructor(private readonly dependencies: {
    dispatcher: WorkspaceRuntimeStartDispatcher;
    endpoint: string;
    sessions: RuntimeSessionStore;
  }) {
    const endpoint = new URL(dependencies.endpoint);
    if (endpoint.protocol !== 'wss:' || endpoint.pathname !== '/api/workspace-runtimes/socket' ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error('Workspace Runtime session endpoint is invalid.');
    }
  }

  async start(input: WorkspaceRuntimeStartAuthority) {
    if (!/^[A-Za-z0-9:._-]{1,256}$/.test(input.operationId)) {
      throw new Error('Workspace Runtime operation identity is invalid.');
    }
    const issued = await this.dependencies.sessions.issue({
      branch: input.branch,
      capabilities: [...workspaceRuntimeCapabilities],
      commit: input.commit,
      environmentId: input.environmentId,
      expiresInSeconds: 300,
      generation: input.generation,
      manifestDigest: input.manifestDigest,
      ownerUserId: input.ownerUserId,
      runtimeVersion: input.runtimeVersion,
      workspaceId: input.workspaceId
    });
    try {
      const result = await this.dependencies.dispatcher.start({
        environmentId: input.environmentId,
        expectedCommit: input.commit,
        expectedGeneration: input.generation,
        expectedManifestDigest: input.manifestDigest,
        mode: input.mode,
        operation: 'workspace-runtime.start.v1',
        operationId: input.operationId,
        ownerUserId: input.ownerUserId,
        runtimeSessionCapabilities: [...issued.credential.capabilities],
        runtimeSessionEndpoint: this.dependencies.endpoint,
        runtimeSessionExpiresAt: issued.credential.expiresAt,
        runtimeSessionToken: issued.credential.token,
        runtimeSessionVersion: input.runtimeVersion,
        workspaceId: input.workspaceId
      });
      if (result.operation !== 'workspace-runtime.start.v1' || result.operationId !== input.operationId ||
        result.workspaceId !== input.workspaceId || result.generation !== input.generation ||
        result.manifestDigest !== input.manifestDigest || result.sourceHead !== input.commit ||
        result.state !== 'running') {
        throw new Error('Workspace Runtime start result binding changed.');
      }
      return {
        credentialId: issued.credential.credentialId,
        expiresAt: issued.credential.expiresAt,
        result
      };
    } catch (error) {
      await this.dependencies.sessions.revoke(
        input.ownerUserId, input.workspaceId, issued.credential.credentialId
      );
      throw error;
    }
  }
}
