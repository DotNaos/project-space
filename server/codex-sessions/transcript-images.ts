import { createHash } from 'node:crypto';

import type { CodexConversationImageRecord } from '../../src/shared/codex-sessions-api';

const MAXIMUM_IMAGE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_IMAGES_PER_MESSAGE = 3;
const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function transcriptMessageImages(
  payload: Record<string, unknown>
): CodexConversationImageRecord[] {
  if (payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) {
    return [];
  }
  const images: CodexConversationImageRecord[] = [];
  for (const value of payload.content) {
    if (images.length >= MAXIMUM_IMAGES_PER_MESSAGE) break;
    if (!isRecord(value) || value.type !== 'input_image' || typeof value.image_url !== 'string') {
      continue;
    }
    const image = safeImage(value.image_url);
    if (image && !images.some((candidate) => candidate.id === image.id)) images.push(image);
  }
  return images;
}

function safeImage(dataUrl: string): CodexConversationImageRecord | undefined {
  const match = dataUrl.match(DATA_URL_PATTERN);
  if (!match) return undefined;
  const mediaType = match[1] as CodexConversationImageRecord['mediaType'];
  const encoded = match[2]!;
  if (encoded.length > Math.ceil(MAXIMUM_IMAGE_BYTES / 3) * 4 + 4) return undefined;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, 'base64');
  } catch {
    return undefined;
  }
  if (
    bytes.length === 0 ||
    bytes.length > MAXIMUM_IMAGE_BYTES ||
    bytes.toString('base64') !== encoded ||
    !hasExpectedSignature(bytes, mediaType)
  ) return undefined;
  return {
    dataUrl,
    id: `transcript-image:${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`,
    mediaType
  };
}

function hasExpectedSignature(
  bytes: Buffer,
  mediaType: CodexConversationImageRecord['mediaType']
) {
  if (mediaType === 'image/png') {
    return bytes.length >= PNG_SIGNATURE.length &&
      bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  }
  return bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
