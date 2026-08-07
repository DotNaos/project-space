export const releaseIntentSchema = 'project-space.release-intent/v1' as const;
export const releaseIntentValues = [
  'none',
  'patch',
  'minor',
  'major',
] as const;
export const releaseIntentDirectory = '.github/release-intents';
export const releaseIntentEnforcementPath =
  `${releaseIntentDirectory}/.enforced`;
export const releaseIntentEnforcementSource =
  `${releaseIntentSchema}\n`;

export type ReleaseIntent = (typeof releaseIntentValues)[number];

export interface ReleaseIntentDocument {
  intent: ReleaseIntent;
  schema: typeof releaseIntentSchema;
}

export type ReleaseIntentParseResult =
  | { intent: ReleaseIntentDocument; ok: true }
  | { errors: string[]; ok: false };

const releaseIntentKeys = ['intent', 'schema'] as const;
const releaseIntentFilePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

export function isReleaseIntentFileName(fileName: string) {
  return releaseIntentFilePattern.test(fileName);
}

export function parseReleaseIntent(
  source: string,
  label = 'Release intent',
): ReleaseIntentParseResult {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return invalid(`${label} must contain valid JSON.`);
  }
  if (!isRecord(value)) {
    return invalid(`${label} must be a JSON object.`);
  }

  const keys = Object.keys(value).sort();
  if (
    keys.length !== releaseIntentKeys.length ||
    keys.some((key, index) => key !== releaseIntentKeys[index])
  ) {
    return invalid(
      `${label} must contain exactly the fields "intent" and "schema".`,
    );
  }
  if (value.schema !== releaseIntentSchema) {
    return invalid(`${label} must use schema "${releaseIntentSchema}".`);
  }
  if (!releaseIntentValues.includes(value.intent as ReleaseIntent)) {
    return invalid(
      `${label} intent must be one of: ${releaseIntentValues.join(', ')}.`,
    );
  }

  return {
    intent: {
      intent: value.intent as ReleaseIntent,
      schema: releaseIntentSchema,
    },
    ok: true,
  };
}

function invalid(error: string): ReleaseIntentParseResult {
  return { errors: [error], ok: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
