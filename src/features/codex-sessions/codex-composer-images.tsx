import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';
import type { CodexSessionUploadedImage } from '@/shared/codex-sessions-api';

const maximumImages = 3;
const maximumImageBytes = 5 * 1024 * 1024;
const supportedImageTypes = new Set(['image/jpeg', 'image/png']);

export interface PendingCodexComposerImage {
  id?: string;
  key: string;
  name: string;
  previewUrl: string;
  status: 'failed' | 'ready' | 'uploading';
}

export function pastedCodexImages(event: ClipboardEvent<HTMLTextAreaElement>) {
  const itemImages = [...event.clipboardData.items]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  return itemImages.length
    ? itemImages
    : [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
}

export function validateCodexComposerImage(file: File) {
  if (!supportedImageTypes.has(file.type)) return 'Choose a PNG or JPEG image.';
  if (file.size === 0 || file.size > maximumImageBytes) return 'Images must be smaller than 5 MB.';
}

export function useCodexComposerImages({
  machineId,
  remove,
  scopeKey,
  upload
}: {
  machineId?: string;
  remove?(machineId: string, attachmentId: string): Promise<void> | void;
  scopeKey?: string;
  upload?(machineId: string, file: File): Promise<CodexSessionUploadedImage>;
}) {
  const [images, setImages] = useState<PendingCodexComposerImage[]>([]);
  const [error, setError] = useState('');
  const imagesRef = useRef(images);
  const removeRef = useRef(remove);
  imagesRef.current = images;
  removeRef.current = remove;

  useEffect(() => () => {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
  }, []);

  useEffect(() => {
    const current = imagesRef.current;
    setImages([]);
    setError('');
    for (const image of current) {
      URL.revokeObjectURL(image.previewUrl);
    }
  }, [scopeKey]);

  async function attach(files: readonly File[]) {
    if (!machineId || !upload) {
      setError('Image attachments are unavailable for this task.');
      return;
    }
    const available = Math.max(0, maximumImages - imagesRef.current.length);
    const accepted = files.slice(0, available);
    if (files.length > accepted.length) setError('Attach up to three images per message.');
    for (const file of accepted) {
      const validationError = validateCodexComposerImage(file);
      if (validationError) {
        setError(validationError);
        continue;
      }
      const key = crypto.randomUUID();
      const previewUrl = URL.createObjectURL(file);
      const pending: PendingCodexComposerImage = {
        key,
        name: file.name || 'Pasted image',
        previewUrl,
        status: 'uploading'
      };
      setImages((current) => [...current, pending]);
      try {
        const uploaded = await upload(machineId, file);
        setImages((current) => current.map((image) => image.key === key
          ? { ...image, id: uploaded.id, status: 'ready' }
          : image));
        setError('');
      } catch {
        setImages((current) => current.map((image) => image.key === key
          ? { ...image, status: 'failed' }
          : image));
        setError('The image could not be attached.');
      }
    }
  }

  function discard(key: string) {
    const image = imagesRef.current.find((entry) => entry.key === key);
    if (!image) return;
    URL.revokeObjectURL(image.previewUrl);
    setImages((current) => current.filter((entry) => entry.key !== key));
    if (image.id && machineId) void remove?.(machineId, image.id);
  }

  function clearAfterSend() {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
    setImages([]);
    setError('');
  }

  return {
    attach,
    clearAfterSend,
    discard,
    error,
    imageAttachmentIds: images.flatMap((image) => image.status === 'ready' && image.id ? [image.id] : []),
    images,
    uploading: images.some((image) => image.status === 'uploading')
  };
}

export function CodexComposerImagePreviews({
  images,
  onDiscard
}: {
  images: readonly PendingCodexComposerImage[];
  onDiscard(key: string): void;
}) {
  if (!images.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2" data-codex-composer-images="true">
      {images.map((image) => (
            <div className="group relative size-14 overflow-hidden rounded-xl border border-neutral-700 bg-neutral-800" key={image.key}>
              <img alt={image.name} className="size-full object-cover" src={image.previewUrl} />
              {image.status === 'uploading' ? (
                <span className="absolute inset-0 grid place-items-center bg-black/45"><Loader2 className="size-4 animate-spin text-white" /></span>
              ) : null}
              {image.status === 'failed' ? <span className="absolute inset-x-0 bottom-0 bg-red-950/90 px-1 py-0.5 text-center text-[9px] text-red-200">Failed</span> : null}
              <button
                aria-label={`Remove ${image.name}`}
                className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-black/70 text-white opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                onClick={() => onDiscard(image.key)}
                type="button"
              >
                <X className="size-3" />
              </button>
            </div>
      ))}
    </div>
  );
}

export function CodexComposerImageButton({
  disabled,
  onAttach
}: {
  disabled: boolean;
  onAttach(files: readonly File[]): void;
}) {
  return (
    <label
        aria-label="Attach an image"
        className={`grid size-9 shrink-0 place-items-center rounded-full transition ${disabled ? 'pointer-events-none opacity-35' : 'cursor-pointer text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100'}`}
        title="Attach PNG or JPEG"
      >
        <ImagePlus className="size-4" />
        <input
          accept="image/jpeg,image/png"
          className="sr-only"
          disabled={disabled}
          multiple
          onChange={(event) => {
            if (event.target.files?.length) onAttach([...event.target.files]);
            event.target.value = '';
          }}
          type="file"
        />
    </label>
  );
}
