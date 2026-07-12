export const projectChatNameCatalog = [
  ['athena', 'Athena', 'mythology'],
  ['hermes', 'Hermes', 'mythology'],
  ['nyx', 'Nyx', 'mythology'],
  ['picasso', 'Picasso', 'artist'],
  ['mondrian', 'Mondrian', 'artist'],
  ['rams', 'Rams', 'artist'],
  ['turing', 'Turing', 'science'],
  ['curie', 'Curie', 'science'],
  ['euler', 'Euler', 'science'],
  ['holmes', 'Holmes', 'detective'],
  ['poirot', 'Poirot', 'detective'],
  ['marple', 'Marple', 'detective']
] as const;

export type ProjectChatNameCategory = typeof projectChatNameCatalog[number][2];
export const reservedProjectChatNames = new Set(['poirot']);

export function findProjectChatName(value: string) {
  const key = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return projectChatNameCatalog.find(([candidate]) => candidate === key);
}
