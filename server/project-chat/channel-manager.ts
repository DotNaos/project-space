import {
  PROJECT_CHAT_GENERAL_CHANNEL_ID,
  ProjectChatError,
  type ProjectChatChannelRecord,
  type ProjectChatClock,
  type ProjectChatContext,
  type ProjectChatIdGenerator,
  type ProjectChatMemberRecord,
  type ProjectChatProject
} from './contracts';
import type { ProjectChatRepository } from './repository';
import { publicProjectChatChannel } from './service-output';

export type ProjectChatProjectProvider = (
  context: ProjectChatContext
) => Promise<ProjectChatProject[]>;

export class ProjectChatChannelManager {
  constructor(
    private readonly repository: ProjectChatRepository,
    private readonly clock: ProjectChatClock,
    private readonly idGenerator: ProjectChatIdGenerator,
    private readonly listProjects: ProjectChatProjectProvider
  ) {}

  async list(context: ProjectChatContext) {
    const general = await this.ensureGeneral(context.spaceId);
    const projects = uniqueProjects(await this.listProjects(context));
    const projectChannels = await Promise.all(
      projects.map(async (project) => ({
        channel: await this.ensureProject(context, project),
        project
      }))
    );
    return {
      channels: [
        publicProjectChatChannel(general),
        ...projectChannels.map(({ channel, project }) =>
          publicProjectChatChannel(channel, project)
        )
      ]
    };
  }

  async ensureSelected(context: ProjectChatContext, projectId?: string) {
    if (!projectId) {
      const channel = await this.ensureGeneral(context.spaceId);
      return { channel, project: undefined };
    }
    const project = (await this.listProjects(context)).find(
      (candidate) => candidate.projectId === projectId
    );
    if (!project) {
      unavailable();
    }
    return {
      channel: await this.ensureProject(context, project),
      project
    };
  }

  async require(context: ProjectChatContext, channelId: string) {
    const channel = await this.repository.findChannel(context.spaceId, channelId);
    if (!channel) {
      unavailable();
    }
    if (channel.kind === 'general') {
      return channel;
    }
    const accountId = actorAccountId(context);
    if (!accountId || channel.accountId !== accountId || !channel.projectId) {
      unavailable();
    }
    const visible = (await this.listProjects(context)).some(
      (project) => project.projectId === channel.projectId
    );
    if (!visible) {
      unavailable();
    }
    return channel;
  }

  membersForChannel(
    context: ProjectChatContext,
    channel: ProjectChatChannelRecord,
    members: ProjectChatMemberRecord[]
  ) {
    if (channel.kind === 'general') {
      return members;
    }
    const accountId = actorAccountId(context);
    return accountId
      ? members.filter((member) => memberAccountId(member) === accountId)
      : [];
  }

  private ensureGeneral(spaceId: string) {
    return this.repository.ensureChannel({
      channelId: PROJECT_CHAT_GENERAL_CHANNEL_ID,
      createdAt: this.clock.now().toISOString(),
      kind: 'general',
      name: 'General',
      spaceId
    });
  }

  private ensureProject(context: ProjectChatContext, project: ProjectChatProject) {
    const accountId = actorAccountId(context);
    if (!accountId) {
      unavailable();
    }
    return this.repository.ensureChannel({
      accountId,
      channelId: this.idGenerator.next('channel'),
      createdAt: this.clock.now().toISOString(),
      kind: 'project',
      name: project.displayName,
      projectId: project.projectId,
      spaceId: context.spaceId
    });
  }
}

function actorAccountId(context: ProjectChatContext) {
  return context.actor.kind === 'human' || context.actor.kind === 'agent'
    ? context.actor.accountId
    : undefined;
}

function memberAccountId(member: ProjectChatMemberRecord) {
  try {
    const actorKey = JSON.parse(member.actorKey) as unknown;
    return Array.isArray(actorKey) &&
      (actorKey[0] === 'human' || actorKey[0] === 'agent') &&
      typeof actorKey[1] === 'string'
      ? actorKey[1]
      : undefined;
  } catch {
    return undefined;
  }
}

function uniqueProjects(projects: ProjectChatProject[]) {
  return [...new Map(projects.map((project) => [project.projectId, project])).values()]
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function unavailable(): never {
  throw new ProjectChatError(
    'channel_unavailable',
    'This Project Chat channel is unavailable.'
  );
}
