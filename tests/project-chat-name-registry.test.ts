import { describe, expect, test } from 'bun:test';
import { InMemoryProjectChatRepository } from '../server/project-chat/memory-store';
import { ProjectChatService } from '../server/project-chat/service';
import type { ProjectChatContext } from '../server/project-chat/contracts';

const threadA='019f4f2b-e97e-7180-9122-4187159dbe51';
const threadB='019f4b93-5703-7692-ad6e-101e32fc4be0';
const agent=(threadId:string,accountId='account-a'):ProjectChatContext=>({spaceId:'space-a',actor:{kind:'agent',accountId,machineId:'machine-a',hostId:'host-a',threadId}});

describe('Project Chat role-based name registry',()=>{
  test('keeps existing claims stable while exposing enough main-agent names for startup',async()=>{
    const service=new ProjectChatService({repository:new InMemoryProjectChatRepository()});
    await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});
    const names=await service.listNames(agent(threadA));
    const mythology=names.groups.find(group=>group.category==='mythology')!.names;
    expect(mythology.length).toBeGreaterThan(40);
    expect(mythology.find(entry=>entry.name==='Athena')).toMatchObject({
      state:'claimed',
      claimedByCurrentThread:true
    });
    expect(mythology.find(entry=>entry.name==='Apollo')).toMatchObject({state:'available'});
  });

  test('claims a main name idempotently and rejects scoped collisions',async()=>{
    const service=new ProjectChatService({repository:new InMemoryProjectChatRepository()});
    const first=await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});
    expect(first.member).toMatchObject({displayName:'Athena',agentName:{name:'Athena',category:'mythology',displayName:'Athena'}});
    expect((await service.claimName(agent(threadA),{name:'Athena',category:'mythology'})).claim).toEqual(first.claim);
    await expect(service.claimName(agent(threadB),{name:'Athena',category:'mythology'})).rejects.toMatchObject({code:'name_conflict'});
    await expect(service.claimName(agent(threadB,'account-b'),{name:'Athena',category:'mythology'})).rejects.toMatchObject({code:'name_conflict'});
    const occupied=await service.listNames(agent(threadB,'account-b'));
    expect(occupied.groups.flatMap(group=>group.names).find(entry=>entry.name==='Athena')).toMatchObject({state:'claimed',claimedByThreadId:threadA});
    await expect(service.claimName({...agent(threadA,'account-b'),spaceId:'space-b'},{name:'Athena',category:'mythology'})).resolves.toBeDefined();
  });

  test('requires a same-account mythology parent and composes specialist display names',async()=>{
    const service=new ProjectChatService({repository:new InMemoryProjectChatRepository()});
    await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});
    await expect(service.claimName(agent(threadB),{name:'Picasso',category:'artist',parentThreadId:threadB})).rejects.toMatchObject({code:'invalid_request'});
    await expect(service.claimName(agent(threadB),{name:'Picasso',category:'artist'})).rejects.toMatchObject({code:'invalid_request'});
    const specialist=await service.claimName(agent(threadB),{name:'Picasso',category:'artist',parentThreadId:threadA});
    expect(specialist.member).toMatchObject({displayName:'Athena.Picasso',agentName:{name:'Picasso',category:'artist',displayName:'Athena.Picasso',parentThreadId:threadA}});
  });

  test('lists the reserved Poirot entry and refuses its claim',async()=>{
    const service=new ProjectChatService({repository:new InMemoryProjectChatRepository()});
    await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});
    const list=await service.listNames(agent(threadA));
    expect(list.groups.flatMap(group=>group.names).find(entry=>entry.name==='Poirot')).toMatchObject({state:'reserved'});
    await expect(service.claimName(agent(threadB),{name:'Poirot',category:'detective',parentThreadId:threadA})).rejects.toMatchObject({code:'invalid_request'});
  });

  test('renames atomically while preserving historical sender snapshots',async()=>{
    const service=new ProjectChatService({repository:new InMemoryProjectChatRepository()});
    const context=agent(threadA);
    await service.claimName(context,{name:'Athena',category:'mythology'});
    const oldMessage=await service.sendMessage(context,{body:'before rename',idempotencyKey:'before'});
    const renamed=await service.claimName(context,{name:'Hermes',category:'mythology'});
    expect(renamed.member).toMatchObject({displayName:'Hermes',agentName:{name:'Hermes',displayName:'Hermes'}});
    const newMessage=await service.sendMessage(context,{body:'after rename',idempotencyKey:'after'});
    expect(oldMessage.sender).toMatchObject({displayName:'Athena',agentName:{name:'Athena'}});
    expect(newMessage.sender).toMatchObject({displayName:'Hermes',agentName:{name:'Hermes'}});
    const messages=(await service.readMessages(context,{afterSequence:0})).messages;
    expect(messages.map(message=>message.sender.displayName)).toEqual(['Athena','Hermes']);
    const names=await service.listNames(context);
    const entries=names.groups.flatMap(group=>group.names);
    expect(entries.find(entry=>entry.name==='Athena')).toMatchObject({state:'available'});
    expect(entries.find(entry=>entry.name==='Hermes')).toMatchObject({state:'claimed',claimedByCurrentThread:true});
    await service.claimName(agent(threadB),{name:'Nyx',category:'mythology'});
    await expect(service.claimName(context,{name:'Nyx',category:'mythology'})).rejects.toMatchObject({code:'name_conflict'});
  });

  test('blocks migrated agent members until their identity is backed by a matching claim',async()=>{
    const repository=new InMemoryProjectChatRepository();
    const context=agent(threadA);
    await repository.upsertMember({spaceId:'space-a',actorKey:JSON.stringify(['agent','account-a','machine-a',threadA]),memberId:'legacy-agent',displayName:'Legacy',handle:'legacy',role:'agent',origin:{threadId:threadA,hostId:'host-a',machineId:'machine-a'},joinedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    const service=new ProjectChatService({repository});
    await expect(service.sendMessage(context,{body:'bypass',idempotencyKey:'legacy'})).rejects.toMatchObject({code:'forbidden'});
    await expect(service.updatePresence(context,{state:'working'})).rejects.toMatchObject({code:'forbidden'});
    await expect(service.readMessages(context)).rejects.toMatchObject({code:'forbidden'});
  });

  test('releases a new claim when member refresh fails and permits a clean retry',async()=>{
    class FailsFirstMemberWrite extends InMemoryProjectChatRepository {
      failures=1;
      override async upsertMember(member: Parameters<InMemoryProjectChatRepository['upsertMember']>[0]) {
        if (this.failures-- > 0) throw new Error('simulated member write failure');
        return super.upsertMember(member);
      }
    }
    const repository=new FailsFirstMemberWrite();
    const service=new ProjectChatService({repository});
    await expect(service.claimName(agent(threadA),{name:'Athena',category:'mythology'})).rejects.toThrow('simulated member write failure');
    expect((await repository.listNameClaims('space-a'))).toEqual([]);
    await expect(service.claimName(agent(threadA),{name:'Athena',category:'mythology'})).resolves.toMatchObject({member:{displayName:'Athena'}});
    expect((await repository.listNameClaims('space-a'))).toHaveLength(1);
  });

  test('restores the previous claim when a rename member refresh fails',async()=>{
    class ToggleMemberFailure extends InMemoryProjectChatRepository {
      fail=false;
      override async upsertMember(member: Parameters<InMemoryProjectChatRepository['upsertMember']>[0]) {
        if(this.fail){this.fail=false;throw new Error('simulated rename refresh failure')}
        return super.upsertMember(member);
      }
    }
    const repository=new ToggleMemberFailure();
    const service=new ProjectChatService({repository});
    await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});
    repository.fail=true;
    await expect(service.claimName(agent(threadA),{name:'Hermes',category:'mythology'})).rejects.toThrow('simulated rename refresh failure');
    expect(await repository.findNameClaimByThread('space-a','account-a',threadA)).toMatchObject({displayName:'Athena',nameKey:'athena'});
    const names=await service.listNames(agent(threadA));
    expect(names.groups.flatMap(group=>group.names).find(entry=>entry.name==='Athena')).toMatchObject({state:'claimed',claimedByCurrentThread:true});
    expect(names.groups.flatMap(group=>group.names).find(entry=>entry.name==='Hermes')).toMatchObject({state:'available'});
  });
});
