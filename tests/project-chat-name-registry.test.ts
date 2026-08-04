import { describe, expect, test } from 'bun:test';
import { InMemoryProjectChatRepository } from '../server/project-chat/memory-store';
import { ProjectChatService } from '../server/project-chat/service';
import type { ProjectChatContext } from '../server/project-chat/contracts';
import {
  automaticProjectChatName,
  automaticProjectChatNameCount,
  automaticProjectChatNameForThread,
  findProjectChatName
} from '../server/project-chat/name-registry';

const threadA='019f4f2b-e97e-7180-9122-4187159dbe51';
const threadB='019f4b93-5703-7692-ad6e-101e32fc4be0';
const agent=(threadId:string,accountId='account-a'):ProjectChatContext=>({spaceId:'space-a',actor:{kind:'agent',accountId,machineId:'machine-a',hostId:'host-a',threadId}});
const leaseMs=48*60*60*1_000;

describe('Project Chat role-based name registry',()=>{
  test('procedurally exposes far more than the previous 1,024 clean names',()=>{
    expect(automaticProjectChatNameCount).toBe(16_384);
    const names=Array.from(
      {length:automaticProjectChatNameCount},
      (_,index)=>automaticProjectChatName(index)[0]
    );
    expect(new Set(names).size).toBe(names.length);
    const threadNames=Array.from(
      {length:automaticProjectChatNameCount},
      (_,index)=>automaticProjectChatNameForThread(threadA,index)[0]
    );
    expect(new Set(threadNames).size).toBe(threadNames.length);
    for(const index of [0,1_024,names.length-1]) {
      expect(findProjectChatName(names[index]??'')).toEqual(automaticProjectChatName(index));
    }
  });

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

  test('renews a 48-hour lease and reclaims it at the exact expiry boundary',async()=>{
    let now=new Date('2026-08-01T00:00:00.000Z');
    const repository=new InMemoryProjectChatRepository();
    const service=new ProjectChatService({repository,clock:{now:()=>new Date(now)},nameLeaseMs:leaseMs});
    await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});

    now=new Date(now.getTime()+leaseMs-1);
    expect((await service.listNames(agent(threadB))).groups[0]?.names.find(name=>name.name==='Athena')).toMatchObject({state:'claimed'});
    await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});

    now=new Date(now.getTime()+leaseMs-1);
    await expect(service.claimName(agent(threadB),{name:'Athena',category:'mythology'})).rejects.toMatchObject({code:'name_conflict'});
    now=new Date(now.getTime()+1);
    await expect(service.claimName(agent(threadB),{name:'Athena',category:'mythology'})).resolves.toMatchObject({claim:{name:'Athena',threadId:threadB}});

    const snapshot=await repository.snapshot();
    expect(snapshot.nameClaims).toHaveLength(1);
    expect(snapshot.members.filter(member=>member.displayName==='Athena')).toHaveLength(2);
    expect(snapshot.members.filter(member=>member.agentName?.name==='Athena')).toHaveLength(1);
    await expect(service.listMembers(agent(threadB))).resolves.toHaveLength(1);
  });

  test('renews the lease through ordinary authenticated agent activity',async()=>{
    let now=new Date('2026-08-01T00:00:00.000Z');
    const repository=new InMemoryProjectChatRepository();
    const service=new ProjectChatService({repository,clock:{now:()=>new Date(now)},nameLeaseMs:leaseMs});
    await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});

    now=new Date(now.getTime()+leaseMs-1);
    await service.listMembers(agent(threadA));
    now=new Date('2026-08-03T00:00:00.000Z');
    expect((await service.listNames(agent(threadB))).groups[0]?.names.find(name=>name.name==='Athena')).toMatchObject({state:'claimed'});
  });

  test('serializes concurrent claims so only one active lease owns a name',async()=>{
    const service=new ProjectChatService({repository:new InMemoryProjectChatRepository()});
    const attempts=await Promise.allSettled(Array.from({length:64},(_,index)=>
      service.claimName(agent(`019f4f2b-e97e-7180-9122-${String(index).padStart(12,'0')}`),{name:'Aebaden',category:'mythology'})
    ));
    expect(attempts.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(attempts.filter(result=>result.status==='rejected')).toHaveLength(63);
  });

  test('allocates well beyond the old limit without duplicate active leases',async()=>{
    const repository=new InMemoryProjectChatRepository();
    const allocationCount=2_048;
    const service=new ProjectChatService({
      repository,
      rateLimits:{join:{limit:allocationCount,windowMs:60_000}}
    });
    for(let index=0;index<allocationCount;index+=1) {
      await service.claimAutomaticName(
        agent(`019f4f2b-e97e-7180-8122-${String(index).padStart(12,'0')}`),
        {}
      );
    }
    const claims=(await repository.snapshot()).nameClaims??[];
    expect(claims).toHaveLength(allocationCount);
    expect(new Set(claims.map(claim=>claim.nameKey)).size).toBe(allocationCount);
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
