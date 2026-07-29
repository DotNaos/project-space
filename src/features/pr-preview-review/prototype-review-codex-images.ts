const MAXIMUM_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

export interface PendingCodexImage {
  id?: string;
  key: string;
  name: string;
  previewUrl: string;
  status: 'failed' | 'ready' | 'uploading';
}

interface UploadedCodexImage {
  id: string;
  mediaType: 'image/jpeg' | 'image/png';
  previewUrl: string;
}

export function validateCodexImageFile(file: File) {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    return 'Choose a PNG or JPEG image.';
  }
  if (file.size === 0 || file.size > MAXIMUM_IMAGE_BYTES) {
    return 'Images must be smaller than 5 MB.';
  }
}

export async function uploadPrototypeReviewCodexImage(file: File) {
  const response = await fetch('/api/prototype-review/codex-images', {
    body: file,
    headers: { 'Content-Type': file.type },
    method: 'POST'
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isUploadedImage(payload)) {
    throw new Error(uploadError(payload));
  }
  return payload;
}

export async function removePrototypeReviewCodexImage(id: string) {
  await fetch(`/api/prototype-review/codex-images/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  }).catch(() => undefined);
}

function isUploadedImage(value: unknown): value is UploadedCodexImage {
  if (!value || typeof value !== 'object') return false;
  const image = value as Partial<UploadedCodexImage>;
  return (
    typeof image.id === 'string' &&
    typeof image.previewUrl === 'string' &&
    (image.mediaType === 'image/jpeg' || image.mediaType === 'image/png')
  );
}

function uploadError(value: unknown) {
  if (value && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string') {
    return (value as { error: string }).error;
  }
  return 'The image could not be attached.';
}
