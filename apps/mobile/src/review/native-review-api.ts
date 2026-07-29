import { fetch as expoFetch } from 'expo/fetch';
import type { ImagePickerAsset } from 'expo-image-picker';

import { createCodexSessionsClient } from '../../../../src/api/codex-sessions-client';
import type {
  CodexModelCatalogueResult,
} from '../../../../src/shared/project-space-api';
import type {
  PrototypeReviewLocalContext,
} from '../../../../src/shared/prototype-review-local-api';
import type { NativeReviewConfig } from './native-review-config';
export { nativeReviewConfig } from './native-review-config';
export type { NativeReviewConfig } from './native-review-config';

export interface NativeReviewImage {
  id: string;
  mediaType: 'image/jpeg' | 'image/png';
  name: string;
  previewUrl: string;
}

const fullSha = /^[0-9a-f]{40}$/;
const repositoryFullName = /^[^/\s]+\/[^/\s]+$/;

export function createNativeReviewCodexClient(origin: string) {
  return createCodexSessionsClient({
    baseUrl: origin,
    fetchImplementation: expoFetch as unknown as typeof globalThis.fetch,
  });
}

export async function loadNativeReviewContext(
  config: NativeReviewConfig,
  signal?: AbortSignal
) {
  const query = new URLSearchParams({
    pr: String(config.pullRequestNumber),
  });
  const response = await expoFetch(
    `${config.origin}/api/prototype-review/local-context?${query}`,
    {
      headers: { Accept: 'application/json' },
      signal,
    }
  );
  if (!response.ok) {
    throw new Error('The local Project Space Review server is not reachable.');
  }
  const value: unknown = await response.json();
  if (!isNativeReviewContext(value)) {
    throw new Error('The local Review server returned an invalid identity.');
  }
  return value;
}

export async function loadNativeReviewModels(origin: string) {
  const response = await expoFetch(
    `${origin}/api/prototype-review/codex-models`,
    { headers: { Accept: 'application/json' } }
  );
  if (!response.ok) throw new Error('Codex model settings are unavailable.');
  return (await response.json()) as CodexModelCatalogueResult;
}

export async function uploadNativeReviewImage(
  origin: string,
  asset: ImagePickerAsset
): Promise<NativeReviewImage> {
  const mediaType = imageMediaType(asset.mimeType, asset.fileName);
  if (!mediaType) throw new Error('Choose a PNG or JPEG image.');
  if (
    typeof asset.fileSize === 'number' &&
    (asset.fileSize < 1 || asset.fileSize > 5 * 1024 * 1024)
  ) {
    throw new Error('Images must be smaller than 5 MB.');
  }
  const source = await expoFetch(asset.uri);
  const bytes = await source.bytes();
  const response = await expoFetch(
    `${origin}/api/prototype-review/codex-images`,
    {
      body: bytes,
      headers: { 'Content-Type': mediaType },
      method: 'POST',
    }
  );
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isUploadedImage(payload)) {
    throw new Error(uploadError(payload));
  }
  return {
    ...payload,
    name: asset.fileName ?? 'Screenshot',
    previewUrl: new URL(payload.previewUrl, origin).toString(),
  };
}

export async function removeNativeReviewImage(origin: string, id: string) {
  await expoFetch(
    `${origin}/api/prototype-review/codex-images/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  ).catch(() => undefined);
}

function isNativeReviewContext(
  value: unknown
): value is PrototypeReviewLocalContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as Partial<PrototypeReviewLocalContext>;
  if (
    typeof context.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(context.checkedAt)) ||
    !context.checkout ||
    !context.codex
  ) {
    return false;
  }
  const checkout = context.checkout;
  const codex = context.codex;
  const checkoutValid =
    checkout.state === 'available'
      ? fullSha.test(checkout.headSha) &&
        repositoryFullName.test(checkout.repositoryFullName)
      : checkout.state === 'unavailable' && typeof checkout.reason === 'string';
  const codexValid =
    codex.state === 'available'
      ? Boolean(codex.machineId && codex.machineName && codex.threadId)
      : codex.state === 'unavailable' && typeof codex.reason === 'string';
  return checkoutValid && codexValid;
}

function imageMediaType(mimeType?: string | null, fileName?: string | null) {
  const normalized = mimeType?.toLowerCase();
  if (normalized === 'image/png') return normalized;
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
    return 'image/jpeg' as const;
  }
  const extension = fileName?.split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png' as const;
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg' as const;
}

function isUploadedImage(value: unknown): value is {
  id: string;
  mediaType: 'image/jpeg' | 'image/png';
  previewUrl: string;
} {
  if (!value || typeof value !== 'object') return false;
  const image = value as {
    id?: unknown;
    mediaType?: unknown;
    previewUrl?: unknown;
  };
  return (
    typeof image.id === 'string' &&
    typeof image.previewUrl === 'string' &&
    (image.mediaType === 'image/jpeg' || image.mediaType === 'image/png')
  );
}

function uploadError(value: unknown) {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { error?: unknown }).error === 'string'
  ) {
    return (value as { error: string }).error;
  }
  return 'The image could not be attached.';
}
