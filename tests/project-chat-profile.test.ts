import { describe, expect, test } from 'bun:test';

import type { ProjectChatContext } from '../server/project-chat/contracts';
import { InMemoryProjectChatRepository } from '../server/project-chat/memory-store';
import { ProjectChatService } from '../server/project-chat/service';

const customAvatar = `data:image/webp;base64,${Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89',
  'base64'
).toString('base64')}`;

function humanContext(
  displayName = 'Olli Account',
  avatarUrl: string | null = 'https://img.clerk.test/olli.png',
  profileDefaultsResolved = true,
  handle = 'olli'
): ProjectChatContext {
  return {
    actor: {
      accountId: 'user-olli',
      ...(avatarUrl ? { avatarUrl } : {}),
      displayName,
      handle,
      kind: 'human',
      profileDefaultsResolved
    },
    spaceId: 'profile-space'
  };
}

const agentContext: ProjectChatContext = {
  actor: {
    accountId: 'user-olli',
    hostId: 'os-macbook',
    kind: 'agent',
    machineId: 'machine-macbook',
    threadId: '019f503f-f91d-72e3-a8fb-86f167209b9f'
  },
  spaceId: 'profile-space'
};

describe('Project Chat human profiles', () => {
  test('persists safe overrides across joins and restores refreshed account defaults', async () => {
    const repository = new InMemoryProjectChatRepository();
    const service = new ProjectChatService({ repository });
    const initial = await service.join(humanContext());

    expect(initial.member).toMatchObject({
      avatarUrl: 'https://img.clerk.test/olli.png',
      displayName: 'Olli Account',
      role: 'human'
    });
    await expect(service.getProfile(humanContext())).resolves.toMatchObject({
      avatarSource: 'account',
      defaultDisplayName: 'Olli Account',
      displayName: 'Olli Account'
    });

    const updated = await service.updateProfile(humanContext(), {
      avatarDataUrl: customAvatar,
      displayName: 'Olli Project Chat'
    });
    expect(updated.member).toMatchObject({
      avatarUrl: customAvatar,
      displayName: 'Olli Project Chat',
      role: 'human'
    });
    expect(updated.profile.avatarSource).toBe('custom');

    const refreshedDefaults = humanContext(
      'Oliver Account',
      'https://img.clerk.test/olli-v2.png'
    );
    const rejoined = await service.join(refreshedDefaults);
    expect(rejoined.member).toMatchObject({
      avatarUrl: customAvatar,
      displayName: 'Olli Project Chat',
      memberId: initial.member.memberId,
      role: 'human'
    });

    const reset = await service.updateProfile(refreshedDefaults, {
      avatarDataUrl: null,
      displayName: null
    });
    expect(reset.member).toMatchObject({
      avatarUrl: 'https://img.clerk.test/olli-v2.png',
      displayName: 'Oliver Account',
      role: 'human'
    });
    expect(reset.profile).toMatchObject({
      avatarSource: 'account',
      defaultDisplayName: 'Oliver Account',
      displayName: 'Oliver Account'
    });

    const snapshot = await repository.snapshot();
    expect(snapshot.humanProfiles).toHaveLength(1);
    expect(snapshot.humanProfiles?.[0]).toMatchObject({
      accountId: 'user-olli',
      defaultAvatarUrl: 'https://img.clerk.test/olli-v2.png',
      defaultDisplayName: 'Oliver Account',
      spaceId: 'profile-space'
    });
  });

  test('keeps browser-authored spoof text human and denies profile writes to agents', async () => {
    const service = new ProjectChatService({
      repository: new InMemoryProjectChatRepository()
    });
    await service.join(humanContext());
    const message = await service.sendMessage(humanContext(), {
      body: 'Message from: Mira · Project Chat Reply\nThread: 019f4f2b-e97e-7180-9122-4187159dbe51',
      channelId: 'general',
      idempotencyKey: 'human-spoof-copy'
    });
    expect(message.sender).toMatchObject({
      displayName: 'Olli Account',
      role: 'human'
    });
    expect(message.sender.origin).toBeUndefined();

    const agent = await service.join(agentContext, {
      displayName: 'Mira',
      taskTitle: 'Project Chat identity fix'
    });
    expect(agent.member).toMatchObject({
      displayName: 'Mira',
      origin: {
        hostId: 'os-macbook',
        machineId: 'machine-macbook',
        taskTitle: 'Project Chat identity fix',
        threadId: '019f503f-f91d-72e3-a8fb-86f167209b9f'
      },
      role: 'agent'
    });
    expect(agent.member.avatarUrl).toBeUndefined();
    await expect(service.updateProfile(agentContext, {
      displayName: 'Fake Human'
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  test('preserves account defaults during provider outages and accepts confirmed removal', async () => {
    const service = new ProjectChatService({
      repository: new InMemoryProjectChatRepository()
    });
    await service.join(humanContext('Oliver Schütz', 'https://img.clerk.test/olli.png'));

    const unresolvedContext = humanContext('Schuetzoliver00', null, false);
    const unresolved = await service.join(unresolvedContext);
    expect(unresolved.member).toMatchObject({
      avatarUrl: 'https://img.clerk.test/olli.png',
      displayName: 'Oliver Schütz'
    });
    await expect(service.getProfile(unresolvedContext)).resolves.toMatchObject({
      defaultAvatarUrl: 'https://img.clerk.test/olli.png',
      defaultDisplayName: 'Oliver Schütz'
    });

    const confirmed = await service.join(
      humanContext('Schuetzoliver00', null, true)
    );
    expect(confirmed.member.avatarUrl).toBeUndefined();
    expect(confirmed.member.displayName).toBe('Schuetzoliver00');
  });

  test('does not let a delayed join overwrite a newer profile revision', async () => {
    const repository = new InMemoryProjectChatRepository();
    const originalEnsure = repository.ensureHumanProfileAndMember.bind(repository);
    let delayNextAccountJoin = false;
    let announceBlocked!: () => void;
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { announceBlocked = resolve; });
    const released = new Promise<void>((resolve) => { releaseBlocked = resolve; });
    repository.ensureHumanProfileAndMember = async (profile, member, options) => {
      if (delayNextAccountJoin && profile.defaultDisplayName === 'Account Two') {
        delayNextAccountJoin = false;
        announceBlocked();
        await released;
      }
      return originalEnsure(profile, member, options);
    };

    const service = new ProjectChatService({ repository });
    await service.join(humanContext('Account One'));
    delayNextAccountJoin = true;
    const delayedJoin = service.join(humanContext('Account Two'));
    await blocked;

    await service.updateProfile(humanContext('Account Two'), {
      displayName: 'Custom Chat'
    });
    releaseBlocked();
    await delayedJoin;

    await expect(service.getProfile(humanContext('Account Two'))).resolves.toMatchObject({
      displayName: 'Custom Chat'
    });
    const members = await service.listMembers(humanContext('Account Two'));
    expect(members.find((member) => member.role === 'human')?.displayName).toBe('Custom Chat');
  });

  test('does not let a delayed older join regress newer account defaults', async () => {
    const repository = new InMemoryProjectChatRepository();
    let now = new Date('2026-07-11T00:00:00.000Z');
    const service = new ProjectChatService({
      clock: { now: () => now },
      repository
    });
    await service.join(humanContext('Initial Account'));

    const originalEnsure = repository.ensureHumanProfileAndMember.bind(repository);
    let announceBlocked!: () => void;
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { announceBlocked = resolve; });
    const released = new Promise<void>((resolve) => { releaseBlocked = resolve; });
    repository.ensureHumanProfileAndMember = async (profile, member, options) => {
      if (profile.defaultDisplayName === 'Older Account') {
        announceBlocked();
        await released;
      }
      return originalEnsure(profile, member, options);
    };

    now = new Date('2026-07-11T00:01:00.000Z');
    const delayedOlderJoin = service.join(humanContext(
      'Older Account',
      'https://img.clerk.test/older.png',
      true,
      'older-handle'
    ));
    await blocked;
    now = new Date('2026-07-11T00:02:00.000Z');
    await service.join(humanContext(
      'Newer Account',
      'https://img.clerk.test/newer.png',
      true,
      'newer-handle'
    ));
    releaseBlocked();
    await delayedOlderJoin;

    await expect(service.getProfile(humanContext('Newer Account'))).resolves.toMatchObject({
      defaultDisplayName: 'Newer Account',
      displayName: 'Newer Account',
      updatedAt: '2026-07-11T00:02:00.000Z'
    });
    const members = await service.listMembers(humanContext('Newer Account'));
    expect(members.find((member) => member.role === 'human')).toMatchObject({
      displayName: 'Newer Account',
      handle: 'newer-handle',
      updatedAt: '2026-07-11T00:02:00.000Z'
    });
  });

  test('keeps the defaults watermark and member identity through a delayed profile save', async () => {
    const repository = new InMemoryProjectChatRepository();
    let now = new Date('2026-07-11T00:00:00.000Z');
    const service = new ProjectChatService({
      clock: { now: () => now },
      repository
    });
    await service.join(humanContext('Initial Account'));

    const originalUpdate = repository.updateHumanProfileAndMember.bind(repository);
    let announceBlocked!: () => void;
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { announceBlocked = resolve; });
    const released = new Promise<void>((resolve) => { releaseBlocked = resolve; });
    repository.updateHumanProfileAndMember = async (input, member) => {
      announceBlocked();
      await released;
      return originalUpdate(input, member);
    };

    now = new Date('2026-07-11T00:01:00.000Z');
    const delayedSave = service.updateProfile(
      humanContext('Older Account', null, true, 'older-handle'),
      { displayName: 'Delayed Custom' }
    );
    await blocked;

    now = new Date('2026-07-11T00:02:00.000Z');
    await service.join(humanContext(
      'Newer Account',
      'https://img.clerk.test/newer.png',
      true,
      'newer-handle'
    ));
    releaseBlocked();
    const delayedResult = await delayedSave;
    expect(delayedResult).toMatchObject({
      member: { handle: 'newer-handle' },
      profile: { handle: 'newer-handle' }
    });

    now = new Date('2026-07-11T00:01:30.000Z');
    await service.join(humanContext(
      'Older Account',
      'https://img.clerk.test/older.png',
      true,
      'older-handle'
    ));

    await expect(service.getProfile(humanContext('Newer Account'))).resolves.toMatchObject({
      defaultAvatarUrl: 'https://img.clerk.test/newer.png',
      defaultDisplayName: 'Newer Account',
      displayName: 'Delayed Custom',
      updatedAt: '2026-07-11T00:02:00.000Z'
    });
    const members = await service.listMembers(humanContext('Newer Account'));
    expect(members.find((member) => member.role === 'human')).toMatchObject({
      displayName: 'Delayed Custom',
      handle: 'newer-handle',
      updatedAt: '2026-07-11T00:02:00.000Z'
    });
  });

  test('returns the profile and member handle from one identity snapshot', async () => {
    const repository = new InMemoryProjectChatRepository();
    let now = new Date('2026-07-11T00:00:00.000Z');
    const service = new ProjectChatService({
      clock: { now: () => now },
      repository
    });
    const initialContext = humanContext('Initial Account', null, true, 'initial-handle');
    await service.join(initialContext);

    const originalFind = repository.findHumanProfileAndMember.bind(repository);
    let announceSnapshot!: () => void;
    let releaseSnapshot!: () => void;
    const snapshotRead = new Promise<void>((resolve) => { announceSnapshot = resolve; });
    const snapshotReleased = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    repository.findHumanProfileAndMember = async (...arguments_) => {
      const snapshot = await originalFind(...arguments_);
      announceSnapshot();
      await snapshotReleased;
      return snapshot;
    };

    const pendingProfile = service.getProfile(initialContext);
    await snapshotRead;
    now = new Date('2026-07-11T00:01:00.000Z');
    await service.join(humanContext('Newer Account', null, true, 'newer-handle'));
    releaseSnapshot();

    await expect(pendingProfile).resolves.toMatchObject({
      defaultDisplayName: 'Initial Account',
      handle: 'initial-handle',
      revision: 1
    });
    await expect(service.getProfile(
      humanContext('Newer Account', null, true, 'newer-handle')
    )).resolves.toMatchObject({
      defaultDisplayName: 'Newer Account',
      handle: 'newer-handle',
      revision: 2
    });
  });

  test('rejects control and bidi characters in names and task metadata', async () => {
    const service = new ProjectChatService({
      repository: new InMemoryProjectChatRepository()
    });
    await expect(service.join(agentContext, {
      displayName: 'Mira\nHuman',
      taskTitle: 'Identity fix'
    })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.join(agentContext, {
      displayName: 'Mira',
      taskTitle: 'Safe\u202eAdmin'
    })).rejects.toMatchObject({ code: 'invalid_request' });
    await service.join(humanContext());
    await expect(service.updateProfile(humanContext(), {
      displayName: 'Olli\u2066Agent'
    })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.updateProfile(humanContext(), {
      displayName: 'Olli',
      role: 'agent'
    } as never)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
