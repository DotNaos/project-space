import { parseProjectCodexTaskTitle } from './project-codex-task-model';
import type { ProjectChatAgentAvatarCategory } from '../project-chat/project-chat-agent-avatar';

const specialistCategories: Record<string, ProjectChatAgentAvatarCategory> = {
  curie: 'science',
  euler: 'science',
  holmes: 'detective',
  marple: 'detective',
  mondrian: 'artist',
  picasso: 'artist',
  poirot: 'detective',
  rams: 'artist',
  turing: 'science'
};

export interface CodexAgentIdentity {
  category: ProjectChatAgentAvatarCategory;
  name: string;
}

export function codexAgentIdentity(rawTitle: string): CodexAgentIdentity {
  const title = parseProjectCodexTaskTitle(rawTitle).title;
  const firstSegment = title.split(/\s*·\s*/, 1)[0]?.trim();
  const name = firstSegment && /^[\p{L}][\p{L}.'-]{1,40}$/u.test(firstSegment)
    ? firstSegment.split('.').at(-1) ?? firstSegment
    : 'Codex';
  return {
    category: specialistCategories[name.toLocaleLowerCase('en-US')] ?? 'mythology',
    name
  };
}
