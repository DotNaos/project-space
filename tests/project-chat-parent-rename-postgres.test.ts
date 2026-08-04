import { describe, expect, test } from 'bun:test';
import type { DatabaseQueryClient, DatabaseQueryResult } from '../server/database/client';
import type {
  ProjectChatMemberRecord,
  ProjectChatNameClaimRecord,
  ProjectChatPresenceRecord
} from '../server/project-chat/contracts';
import { PostgresProjectChatRepository } from '../server/project-chat/postgres-store';
import { ProjectChatHandleConflictError } from '../server/project-chat/repository';

interface QueryCall { sql:string; values:readonly unknown[] }
type Response=DatabaseQueryResult<unknown>|Error;
class RecordingClient implements DatabaseQueryClient {
  readonly calls:QueryCall[]=[];
  readonly events:string[]=[];
  constructor(private readonly responses:Response[]) {}
  async query<Row>(sql:string,values:readonly unknown[]=[]){
    this.calls.push({sql,values});
    this.events.push(sql.trim().split(/\s+/,1)[0]??'query');
    const response=this.responses.shift();
    if(!response) throw new Error(`Unexpected query: ${sql}`);
    if(response instanceof Error) throw response;
    return response as DatabaseQueryResult<Row>;
  }
  async transaction<Result>(operation:(client:DatabaseQueryClient)=>Promise<Result>){
    this.events.push('begin');
    try { const result=await operation(this);this.events.push('commit');return result; }
    catch(error){this.events.push('rollback');throw error;}
  }
}
const rows=<Row>(values:Row[]):DatabaseQueryResult<Row>=>({rowCount:values.length,rows:values});
const createdAt='2026-07-11T10:00:00.000Z';
const updatedAt='2026-07-12T10:00:00.000Z';
const expiresAt='2026-07-13T10:00:00.000Z';
const databaseConflict=()=>Object.assign(new Error('unique violation'),{
  code:'23505',constraint:'project_chat_members_space_handle_unique'
});
function memberRecord(overrides:Partial<ProjectChatMemberRecord>={}):ProjectChatMemberRecord{
  return {actorKey:'agent:machine-a:thread-a',displayName:'Galileo',handle:'galileo',
    joinedAt:createdAt,memberId:'member-a',role:'agent',spaceId:'space-a',
    updatedAt:createdAt,...overrides};
}
function memberRow(overrides:Record<string,unknown>={}){
  const member=memberRecord();
  return {actor_key:member.actorKey,agent_name:member.agentName??null,avatar_url:null,
    display_name:member.displayName,handle:member.handle,joined_at:member.joinedAt,
    member_id:member.memberId,origin:null,profile_revision:null,role:member.role,
    space_id:member.spaceId,updated_at:member.updatedAt,...overrides};
}
function nameClaimRow(overrides:Record<string,unknown>={}){
  return {account_id:'account-a',actor_key:'agent:machine-a:thread-a',
    category:'mythology',claimed_at:createdAt,display_name:'Athena',name_key:'athena',
    parent_thread_id:null,space_id:'space-a',thread_id:'thread-a',updated_at:createdAt,
    ...overrides};
}
function dependentSpecialistRow(){
  return {...memberRow({actor_key:'agent:machine-a:thread-b',agent_name:{category:'science',
    displayName:'Athena.Turing',name:'Turing',parentThreadId:'thread-a'},
  display_name:'Athena.Turing',handle:'athena-turing',member_id:'member-b'}),
  child_account_id:'account-a',child_actor_key:'agent:machine-a:thread-b',
  child_category:'science',child_claimed_at:createdAt,child_display_name:'Turing',
  child_name_key:'turing',child_parent_thread_id:'thread-a',child_thread_id:'thread-b',
  child_updated_at:createdAt};
}
function renameInput(name:'Hermes'|'Apollo'){
  const claim:ProjectChatNameClaimRecord={accountId:'account-a',
    actorKey:'agent:machine-a:thread-a',category:'mythology',claimedAt:updatedAt,
    displayName:name,nameKey:name.toLowerCase(),spaceId:'space-a',threadId:'thread-a',updatedAt};
  const member=memberRecord({displayName:name,handle:name.toLowerCase(),updatedAt,
    agentName:{name,category:'mythology',displayName:name}});
  const presence:ProjectChatPresenceRecord={expiresAt,lastSeenAt:updatedAt,
    memberId:member.memberId,spaceId:member.spaceId,state:'working'};
  return {claim,member,presence};
}

describe('PostgreSQL parent rename transaction',()=>{
  test('commits the parent identity and presence together',async()=>{
    const {claim,member,presence}=renameInput('Hermes');
    const client=new RecordingClient([rows([nameClaimRow()]),rows([]),
      rows([nameClaimRow({name_key:'hermes',display_name:'Hermes',updated_at:updatedAt})]),
      rows([memberRow({member_id:'persisted-member',display_name:'Hermes',handle:'hermes',
        updated_at:updatedAt,agent_name:member.agentName})]),
      rows([{expires_at:expiresAt,last_seen_at:updatedAt,member_id:'persisted-member',
        space_id:member.spaceId,state:'working'}])]);
    await expect(new PostgresProjectChatRepository(client).claimNameAndJoin(
      claim,member,presence
    )).resolves.toMatchObject({claim:{nameKey:'hermes'},member:{displayName:'Hermes'},
      presence:{memberId:'persisted-member'}});
    expect(client.events).toEqual(['begin','select','select','update','insert','insert','commit']);
    expect(client.calls[4]?.values[1]).toBe('persisted-member');

    const memberFailure=new Error('forced member failure');
    const failingClient=new RecordingClient([rows([nameClaimRow()]),rows([]),
      rows([nameClaimRow({name_key:'hermes',display_name:'Hermes',updated_at:updatedAt})]),
      memberFailure]);
    await expect(new PostgresProjectChatRepository(failingClient).claimNameAndJoin(
      claim,member,presence
    )).rejects.toBe(memberFailure);
    expect(failingClient.events).toEqual(['begin','select','select','update','insert','rollback']);
  });

  test('rolls back when Apollo.Turing conflicts with an active handle',async()=>{
    const {claim,member,presence}=renameInput('Apollo');
    const client=new RecordingClient([rows([nameClaimRow()]),rows([dependentSpecialistRow()]),
      rows([nameClaimRow({name_key:'apollo',display_name:'Apollo',updated_at:updatedAt})]),
      rows([memberRow({display_name:'Apollo',handle:'apollo',updated_at:updatedAt,
        agent_name:member.agentName})]),databaseConflict()]);
    await expect(new PostgresProjectChatRepository(client).claimNameAndJoin(
      claim,member,presence
    )).rejects.toBeInstanceOf(ProjectChatHandleConflictError);
    expect(client.calls[1]?.sql).toContain('for update of claim, member');
    expect(client.calls[4]?.values[3]).toBe('Apollo.Turing');
    expect(client.calls[4]?.values[4]).toBe('apollo-turing');
    expect(client.events).toEqual(['begin','select','select','update','insert','insert','rollback']);
  });
});
