export type ProjectChatNameEntry = readonly [
  key: string,
  displayName: string,
  category: 'mythology' | 'artist' | 'science' | 'detective'
];

export const projectChatNameCatalog = [
  ['athena', 'Athena', 'mythology'],
  ['hermes', 'Hermes', 'mythology'],
  ['nyx', 'Nyx', 'mythology'],
  ['apollo', 'Apollo', 'mythology'],
  ['artemis', 'Artemis', 'mythology'],
  ['ares', 'Ares', 'mythology'],
  ['hera', 'Hera', 'mythology'],
  ['hestia', 'Hestia', 'mythology'],
  ['demeter', 'Demeter', 'mythology'],
  ['persephone', 'Persephone', 'mythology'],
  ['selene', 'Selene', 'mythology'],
  ['helios', 'Helios', 'mythology'],
  ['eos', 'Eos', 'mythology'],
  ['iris', 'Iris', 'mythology'],
  ['nike', 'Nike', 'mythology'],
  ['themis', 'Themis', 'mythology'],
  ['nemesis', 'Nemesis', 'mythology'],
  ['hecate', 'Hecate', 'mythology'],
  ['pan', 'Pan', 'mythology'],
  ['orpheus', 'Orpheus', 'mythology'],
  ['theseus', 'Theseus', 'mythology'],
  ['perseus', 'Perseus', 'mythology'],
  ['ariadne', 'Ariadne', 'mythology'],
  ['echo', 'Echo', 'mythology'],
  ['gaia', 'Gaia', 'mythology'],
  ['rhea', 'Rhea', 'mythology'],
  ['maia', 'Maia', 'mythology'],
  ['metis', 'Metis', 'mythology'],
  ['clio', 'Clio', 'mythology'],
  ['thalia', 'Thalia', 'mythology'],
  ['calliope', 'Calliope', 'mythology'],
  ['erato', 'Erato', 'mythology'],
  ['urania', 'Urania', 'mythology'],
  ['circe', 'Circe', 'mythology'],
  ['calypso', 'Calypso', 'mythology'],
  ['hypnos', 'Hypnos', 'mythology'],
  ['morpheus', 'Morpheus', 'mythology'],
  ['triton', 'Triton', 'mythology'],
  ['atlas', 'Atlas', 'mythology'],
  ['janus', 'Janus', 'mythology'],
  ['aurora', 'Aurora', 'mythology'],
  ['luna', 'Luna', 'mythology'],
  ['flora', 'Flora', 'mythology'],
  ['minerva', 'Minerva', 'mythology'],
  ['vesta', 'Vesta', 'mythology'],
  ['diana', 'Diana', 'mythology'],
  ['mercury', 'Mercury', 'mythology'],
  ['juno', 'Juno', 'mythology'],
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

const automaticNamePrefixes = [
  'ae', 'al', 'ar', 'bel', 'bri', 'ca', 'cor', 'da',
  'el', 'fa', 'fen', 'gal', 'hal', 'is', 'jo', 'ka',
  'kel', 'la', 'lor', 'ma', 'mer', 'na', 'nor', 'or',
  'per', 'quin', 'ra', 'sel', 'tal', 'val', 'wen', 'ze'
] as const;

const automaticNameMiddles = [
  'ba', 'ce', 'di', 'el', 'fi', 'ga', 'ha', 'io',
  'ka', 'lu', 'mi', 'no', 'or', 'ra', 'su', 've'
] as const;

const automaticNameSuffixes = [
  'den', 'dra', 'el', 'en', 'er', 'ia', 'ian', 'il',
  'in', 'io', 'is', 'on', 'or', 'os', 'ra', 'ran',
  'ren', 'ria', 'ric', 'rin', 'ro', 'sa', 'sel', 'sor',
  'ta', 'th', 'tor', 'va', 'ven', 'yn', 'yor', 'zen'
] as const;

export const automaticProjectChatNameCount =
  automaticNamePrefixes.length * automaticNameMiddles.length * automaticNameSuffixes.length;

export function automaticProjectChatName(index: number): ProjectChatNameEntry {
  if (!Number.isSafeInteger(index) || index < 0 || index >= automaticProjectChatNameCount) {
    throw new RangeError('Automatic Project Chat name index is outside the catalogue.');
  }
  const suffixIndex = index % automaticNameSuffixes.length;
  const middlePosition = Math.floor(index / automaticNameSuffixes.length);
  const middleIndex = middlePosition % automaticNameMiddles.length;
  const prefixIndex = Math.floor(middlePosition / automaticNameMiddles.length);
  const key = `${automaticNamePrefixes[prefixIndex]}${automaticNameMiddles[middleIndex]}${automaticNameSuffixes[suffixIndex]}`;
  return [key, `${key.charAt(0).toLocaleUpperCase('en-US')}${key.slice(1)}`, 'mythology'];
}

export function automaticProjectChatNameForThread(
  threadId: string,
  attempt: number
): ProjectChatNameEntry {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= automaticProjectChatNameCount) {
    throw new RangeError('Automatic Project Chat name attempt is outside the catalogue.');
  }
  const start = stableNameHash(threadId) % automaticProjectChatNameCount;
  const step = (stableNameHash(`step:${threadId}`) % (automaticProjectChatNameCount / 2)) * 2 + 1;
  return automaticProjectChatName((start + attempt * step) % automaticProjectChatNameCount);
}

function stableNameHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const automaticNamesByKey = new Map(
  Array.from(
    { length: automaticProjectChatNameCount },
    (_, index) => automaticProjectChatName(index)
  ).map((entry) => [entry[0], entry] as const)
);

export function findProjectChatName(value: string): ProjectChatNameEntry | undefined {
  const key = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const curated = projectChatNameCatalog.find(([candidate]) => candidate === key);
  if (curated) return curated;
  return automaticNamesByKey.get(key);
}
