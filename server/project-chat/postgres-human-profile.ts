import type { DatabaseQueryClient } from '../database/client';
import type { ProjectChatHumanProfileRecord } from './contracts';
import type { ProjectChatHumanProfileUpdate } from './repository';

interface HumanProfileRow {
  account_id: string;
  avatar_data_url_override: string | null;
  created_at: Date | string;
  default_avatar_url: string | null;
  default_display_name: string;
  display_name_override: string | null;
  revision: number | string;
  space_id: string;
  updated_at: Date | string;
}

export async function ensurePostgresHumanProfile(
  client: DatabaseQueryClient,
  profile: ProjectChatHumanProfileRecord,
  options: { refreshDefaults?: boolean } = {}
) {
  const refreshDefaults = options.refreshDefaults !== false;
  const result = await client.query<HumanProfileRow>(
    `insert into project_chat_human_profiles (
       space_id, account_id, default_display_name, default_avatar_url,
       display_name_override, avatar_data_url_override, created_at, updated_at, revision
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (space_id, account_id) do update set
       default_display_name = case when $10 and excluded.updated_at >= project_chat_human_profiles.updated_at
                                   then excluded.default_display_name
                                   else project_chat_human_profiles.default_display_name end,
       default_avatar_url = case when $10 and excluded.updated_at >= project_chat_human_profiles.updated_at
                                 then excluded.default_avatar_url
                                 else project_chat_human_profiles.default_avatar_url end,
       revision = case when $10 and excluded.updated_at >= project_chat_human_profiles.updated_at
                       then project_chat_human_profiles.revision + 1
                       else project_chat_human_profiles.revision end,
       updated_at = case when $10 and excluded.updated_at >= project_chat_human_profiles.updated_at
                         then excluded.updated_at
                         else project_chat_human_profiles.updated_at end
     returning ${humanProfileColumns}`,
    [
      profile.spaceId,
      profile.accountId,
      profile.defaultDisplayName,
      profile.defaultAvatarUrl ?? null,
      profile.displayNameOverride ?? null,
      profile.avatarDataUrlOverride ?? null,
      profile.createdAt,
      profile.updatedAt,
      profile.revision,
      refreshDefaults
    ]
  );
  return mapHumanProfile(requireProfileRow(result.rows[0]));
}

export async function findPostgresHumanProfile(
  client: DatabaseQueryClient,
  spaceId: string,
  accountId: string,
  options: { forShare?: boolean } = {}
) {
  const result = await client.query<HumanProfileRow>(
    `select ${humanProfileColumns}
       from project_chat_human_profiles
      where space_id = $1 and account_id = $2
      ${options.forShare ? 'for share' : ''}`,
    [spaceId, accountId]
  );
  return result.rows[0] ? mapHumanProfile(result.rows[0]) : null;
}

export async function updatePostgresHumanProfile(
  client: DatabaseQueryClient,
  input: ProjectChatHumanProfileUpdate
) {
  const updateDisplayName = Object.hasOwn(input, 'displayNameOverride');
  const updateAvatar = Object.hasOwn(input, 'avatarDataUrlOverride');
  const result = await client.query<HumanProfileRow>(
    `update project_chat_human_profiles
        set display_name_override = case when $3 then $4 else display_name_override end,
            avatar_data_url_override = case when $5 then $6 else avatar_data_url_override end,
            updated_at = greatest(updated_at, $7::timestamptz),
            revision = revision + 1
      where space_id = $1 and account_id = $2
      returning ${humanProfileColumns}`,
    [
      input.spaceId,
      input.accountId,
      updateDisplayName,
      input.displayNameOverride ?? null,
      updateAvatar,
      input.avatarDataUrlOverride ?? null,
      input.updatedAt
    ]
  );
  return mapHumanProfile(requireProfileRow(result.rows[0]));
}

const humanProfileColumns = `space_id, account_id, default_display_name,
  default_avatar_url, display_name_override, avatar_data_url_override, created_at, updated_at,
  revision`;

function mapHumanProfile(row: HumanProfileRow): ProjectChatHumanProfileRecord {
  return {
    accountId: row.account_id,
    avatarDataUrlOverride: row.avatar_data_url_override ?? undefined,
    createdAt: isoString(row.created_at),
    defaultAvatarUrl: row.default_avatar_url ?? undefined,
    defaultDisplayName: row.default_display_name,
    displayNameOverride: row.display_name_override ?? undefined,
    revision: positiveInteger(row.revision, 'revision'),
    spaceId: row.space_id,
    updatedAt: isoString(row.updated_at)
  };
}

function isoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function positiveInteger(value: number | string, column: string) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${column} returned by the database.`);
  }
  return parsed;
}

function requireProfileRow(row: HumanProfileRow | undefined) {
  if (!row) {
    throw new Error('Project Chat human profile could not be stored.');
  }
  return row;
}
