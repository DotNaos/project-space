import type {
  ProjectChatMemberRecord,
  ProjectChatNameClaimRecord,
  ProjectChatPresenceRecord
} from './contracts';

const key = (...parts:string[]) => JSON.stringify(parts);
const clone = <Value>(value:Value):Value => structuredClone(value);

function snapshotEntries<MapKey, Value>(source:Map<MapKey,Value>, keys:Iterable<MapKey>) {
  return new Map([...keys].map((entry) => [entry, source.has(entry)
    ? clone(source.get(entry) as Value)
    : undefined] as const));
}

function restoreEntries<MapKey, Value>(
  target:Map<MapKey,Value>,
  snapshot:Map<MapKey,Value|undefined>
) {
  for (const [entry,value] of snapshot) {
    if (value === undefined) target.delete(entry);
    else target.set(entry,clone(value));
  }
}

export function captureMemoryNameJoinTransaction(input:{
  claim:ProjectChatNameClaimRecord;
  existing:ProjectChatNameClaimRecord|undefined;
  memberIdByActor:Map<string,string>;
  memberIdByHandle:Map<string,string>;
  members:ProjectChatMemberRecord[];
  membersById:Map<string,ProjectChatMemberRecord>;
  nameClaims:Map<string,ProjectChatNameClaimRecord>;
  presence:ProjectChatPresenceRecord;
  presences:Map<string,ProjectChatPresenceRecord>;
  retiredMemberIds:Set<string>;
}) {
  const actorKeys=new Set(input.members.map((member)=>key(member.spaceId,member.actorKey)));
  const existingMembers=[...actorKeys].flatMap((actorKey)=>{
    const memberId=input.memberIdByActor.get(actorKey);
    if(!memberId) return [];
    const member=input.membersById.get(key(input.claim.spaceId,memberId));
    return member?[member]:[];
  });
  const memberIds=new Set([
    ...input.members.map((member)=>member.memberId),
    ...existingMembers.map((member)=>member.memberId)
  ]);
  const memberKeys=new Set([...memberIds].map((memberId)=>key(input.claim.spaceId,memberId)));
  const handleKeys=new Set([...input.members,...existingMembers].map((member)=>
    key(member.spaceId,member.handle.toLowerCase())
  ));
  const claimKeys=new Set([
    key(input.claim.spaceId,input.claim.nameKey),
    ...(input.existing?[key(input.existing.spaceId,input.existing.nameKey)]:[])
  ]);
  const presenceKeys=new Set([...memberIds,input.presence.memberId].map((memberId)=>
    key(input.claim.spaceId,memberId)
  ));
  const snapshots={
    actor:snapshotEntries(input.memberIdByActor,actorKeys),
    claim:snapshotEntries(input.nameClaims,claimKeys),
    handle:snapshotEntries(input.memberIdByHandle,handleKeys),
    member:snapshotEntries(input.membersById,memberKeys),
    presence:snapshotEntries(input.presences,presenceKeys),
    retired:new Map([...memberIds].map((memberId)=>[memberId,input.retiredMemberIds.has(memberId)]))
  };
  return () => {
    restoreEntries(input.memberIdByActor,snapshots.actor);
    restoreEntries(input.nameClaims,snapshots.claim);
    restoreEntries(input.memberIdByHandle,snapshots.handle);
    restoreEntries(input.membersById,snapshots.member);
    restoreEntries(input.presences,snapshots.presence);
    for(const [memberId,wasRetired] of snapshots.retired) {
      if(wasRetired) input.retiredMemberIds.add(memberId);
      else input.retiredMemberIds.delete(memberId);
    }
  };
}
