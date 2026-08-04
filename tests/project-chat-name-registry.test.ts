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
import { normalizeProjectChatHandle } from '../server/project-chat/validation';

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

  test('never lets a stale activity renewal undo a concurrent rename',async()=>{
    let pause=false;
    let entered!:()=>void;
    let release!:()=>void;
    const paused=new Promise<void>(resolve=>{entered=resolve});
    const resume=new Promise<void>(resolve=>{release=resolve});
    class PausesRenewal extends InMemoryProjectChatRepository {
      override async renewNameClaim(...args:Parameters<InMemoryProjectChatRepository['renewNameClaim']>) {
        if(pause){entered();await resume}
        return super.renewNameClaim(...args);
      }
    }
    const repository=new PausesRenewal();
    const service=new ProjectChatService({repository});
    const context=agent(threadA);
    await service.claimName(context,{name:'Athena',category:'mythology'});
    pause=true;
    const activity=service.listMembers(context);
    await paused;
    await service.claimName(context,{name:'Hermes',category:'mythology'});
    release();
    await expect(activity).resolves.toEqual([
      expect.objectContaining({displayName:'Hermes',agentName:expect.objectContaining({name:'Hermes'})})
    ]);
    expect(await repository.listNameClaims('space-a')).toEqual([
      expect.objectContaining({nameKey:'hermes',displayName:'Hermes'})
    ]);
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
      rateLimits:{join:{limit:allocationCount*8,windowMs:60_000}}
    });
    await Promise.all(Array.from({length:allocationCount},(_,index)=>
      service.claimAutomaticName(
        agent(`019f4f2b-e97e-7180-8122-${String(index).padStart(12,'0')}`),
        {}
      )
    ));
    const claims=(await repository.snapshot()).nameClaims??[];
    expect(claims).toHaveLength(allocationCount);
    expect(new Set(claims.map(claim=>claim.nameKey)).size).toBe(allocationCount);
  });

  test('preserves a clean offline name when the same thread reconnects online',async()=>{
    const repository=new InMemoryProjectChatRepository();
    const service=new ProjectChatService({repository});
    await expect(service.claimAutomaticName(agent(threadA),{
      preferredName:'Aebaden'
    })).resolves.toMatchObject({claim:{name:'Aebaden'},member:{displayName:'Aebaden'}});
    await expect(service.claimAutomaticName(agent(threadB),{
      preferredName:'Aebaden'
    })).resolves.not.toMatchObject({claim:{name:'Aebaden'}});
    expect(new Set((await repository.listNameClaims('space-a')).map(claim=>claim.nameKey)).size).toBe(2);
  });

  test('advances when a non-agent member owns the first candidate handle',async()=>{
    const repository=new InMemoryProjectChatRepository();
    const [firstName]=automaticProjectChatNameForThread(threadA,0);
    const [,secondName]=automaticProjectChatNameForThread(threadA,1);
    await repository.upsertMember({
      spaceId:'space-a',actorKey:'human-owner',memberId:'human-owner',displayName:firstName,
      handle:normalizeProjectChatHandle(firstName),role:'human',joinedAt:new Date().toISOString(),
      updatedAt:new Date().toISOString()
    });
    const service=new ProjectChatService({repository});
    await expect(service.claimAutomaticName(agent(threadA))).resolves.toMatchObject({
      claim:{name:secondName}
    });
  });

  test('requires a same-account mythology parent and composes specialist display names',async()=>{
    const service=new ProjectChatService({repository:new InMemoryProjectChatRepository()});
    await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});
    await expect(service.claimName(agent(threadB),{name:'Picasso',category:'artist',parentThreadId:threadB})).rejects.toMatchObject({code:'invalid_request'});
    await expect(service.claimName(agent(threadB),{name:'Picasso',category:'artist'})).rejects.toMatchObject({code:'invalid_request'});
    const specialist=await service.claimName(agent(threadB),{name:'Picasso',category:'artist',parentThreadId:threadA});
    expect(specialist.member).toMatchObject({displayName:'Athena.Picasso',agentName:{name:'Picasso',category:'artist',displayName:'Athena.Picasso',parentThreadId:threadA}});
  });

  test('revalidates and composes a specialist against the parent inside the atomic join',async()=>{
    let entered!:()=>void;
    let release!:()=>void;
    const paused=new Promise<void>(resolve=>{entered=resolve});
    const resume=new Promise<void>(resolve=>{release=resolve});
    class PausesSpecialistJoin extends InMemoryProjectChatRepository {
      override async claimNameAndJoin(...args:Parameters<InMemoryProjectChatRepository['claimNameAndJoin']>) {
        if(args[0].parentThreadId){entered();await resume}
        return super.claimNameAndJoin(...args);
      }
    }
    const service=new ProjectChatService({repository:new PausesSpecialistJoin()});
    await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});
    const specialist=service.claimName(agent(threadB),{name:'Picasso',category:'artist',parentThreadId:threadA});
    await paused;
    await service.claimName(agent(threadA),{name:'Hermes',category:'mythology'});
    release();
    await expect(specialist).resolves.toMatchObject({
      claim:{displayName:'Hermes.Picasso'},
      member:{displayName:'Hermes.Picasso',agentName:{displayName:'Hermes.Picasso'}}
    });
  });

  test('concurrent joins for one actor share the stored member identity and presence',async()=>{
    const repository=new InMemoryProjectChatRepository();
    const service=new ProjectChatService({repository});
    const [first,second]=await Promise.all([
      service.claimName(agent(threadA),{name:'Athena',category:'mythology'}),
      service.claimName(agent(threadA),{name:'Athena',category:'mythology'})
    ]);
    expect(first.member.memberId).toBe(second.member.memberId);
    const snapshot=await repository.snapshot();
    expect(snapshot.members).toHaveLength(1);
    expect(snapshot.presences).toEqual([expect.objectContaining({memberId:first.member.memberId})]);
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

  test('refreshes a specialist identity after its parent is renamed',async()=>{
    const repository=new InMemoryProjectChatRepository();
    const service=new ProjectChatService({repository});
    await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});
    await service.claimName(agent(threadB),{name:'Picasso',category:'artist',parentThreadId:threadA});
    await service.claimName(agent(threadA),{name:'Hermes',category:'mythology'});

    await expect(service.listMembers(agent(threadB))).resolves.toContainEqual(
      expect.objectContaining({
        displayName:'Hermes.Picasso',
        handle:'hermes-picasso',
        agentName:expect.objectContaining({displayName:'Hermes.Picasso'})
      })
    );
    await expect(repository.findMemberByActorKey(
      'space-a',JSON.stringify(['agent','account-a','machine-a',threadB])
    )).resolves.toMatchObject({displayName:'Hermes.Picasso',handle:'hermes-picasso'});
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
      protected override upsertMemberRecord(member: Parameters<InMemoryProjectChatRepository['upsertMember']>[0]) {
        if (this.failures-- > 0) throw new Error('simulated member write failure');
        return super.upsertMemberRecord(member);
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
      protected override upsertMemberRecord(member: Parameters<InMemoryProjectChatRepository['upsertMember']>[0]) {
        if(this.fail){this.fail=false;throw new Error('simulated rename refresh failure')}
        return super.upsertMemberRecord(member);
      }
    }
    const repository=new ToggleMemberFailure();
    let now=Date.parse('2026-08-01T00:00:00.000Z');
    const service=new ProjectChatService({repository,clock:{now:()=>new Date(now++)}});
    await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});
    repository.fail=true;
    await expect(service.claimName(agent(threadA),{name:'Hermes',category:'mythology'})).rejects.toThrow('simulated rename refresh failure');
    expect(await repository.findNameClaimByThread('space-a','account-a',threadA)).toMatchObject({displayName:'Athena',nameKey:'athena'});
    const names=await service.listNames(agent(threadA));
    expect(names.groups.flatMap(group=>group.names).find(entry=>entry.name==='Athena')).toMatchObject({state:'claimed',claimedByCurrentThread:true});
    expect(names.groups.flatMap(group=>group.names).find(entry=>entry.name==='Hermes')).toMatchObject({state:'available'});
  });

  test('serializes a failed rename with a competing claim of the old name',async()=>{
    class FailsHermesMemberWrite extends InMemoryProjectChatRepository {
      protected override upsertMemberRecord(member: Parameters<InMemoryProjectChatRepository['upsertMember']>[0]) {
        if(member.displayName==='Hermes') throw new Error('simulated rename refresh failure');
        return super.upsertMemberRecord(member);
      }
    }
    const repository=new FailsHermesMemberWrite();
    const service=new ProjectChatService({repository});
    await service.claimName(agent(threadA),{name:'Athena',category:'mythology'});
    const [rename,competingClaim]=await Promise.allSettled([
      service.claimName(agent(threadA),{name:'Hermes',category:'mythology'}),
      service.claimName(agent(threadB),{name:'Athena',category:'mythology'})
    ]);
    expect(rename).toMatchObject({status:'rejected'});
    expect(competingClaim).toMatchObject({status:'rejected',reason:{code:'name_conflict'}});
    expect(await repository.listNameClaims('space-a')).toEqual([
      expect.objectContaining({threadId:threadA,nameKey:'athena',displayName:'Athena'})
    ]);
    expect(await service.listMembers(agent(threadA))).toEqual([
      expect.objectContaining({displayName:'Athena',agentName:expect.objectContaining({name:'Athena'})})
    ]);
  });
});
