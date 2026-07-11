const acceptedAvatarTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maximumInputBytes = 8 * 1024 * 1024;
const maximumOutputBytes = 256 * 1024;
const targetSizes = [512, 384, 256] as const;
const outputQualities = [0.86, 0.72, 0.58] as const;

interface DecodedAvatar {
  height: number;
  source: CanvasImageSource;
  width: number;
  close(): void;
}

export async function prepareProjectChatAvatar(file: File) {
  if (!acceptedAvatarTypes.has(file.type)) {
    throw new Error('Choose a PNG, JPEG, or WebP image.');
  }
  if (file.size < 1 || file.size > maximumInputBytes) {
    throw new Error('Choose an image smaller than 8 MB.');
  }

  const image = await decodeAvatar(file);
  try {
    if (image.width < 1 || image.height < 1) {
      throw new Error('The selected image could not be read.');
    }
    for (const maximumSize of targetSizes) {
      const scale = Math.min(1, maximumSize / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: true });
      if (!context) {
        throw new Error('Profile image editing is unavailable in this browser.');
      }
      context.drawImage(image.source, 0, 0, width, height);
      for (const quality of outputQualities) {
        const blob = await canvasBlob(canvas, 'image/webp', quality);
        if (blob && blob.size <= maximumOutputBytes) {
          return blobDataUrl(blob);
        }
      }
    }
  } finally {
    image.close();
  }
  throw new Error('The profile image is too detailed. Choose a simpler or smaller image.');
}

async function decodeAvatar(file: File): Promise<DecodedAvatar> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        close: () => bitmap.close(),
        height: bitmap.height,
        source: bitmap,
        width: bitmap.width
      };
    } catch {
      // Safari can reject image types it still decodes through an image element.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.decoding = 'async';
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('The selected image could not be read.'));
      element.src = objectUrl;
    });
    return {
      close: () => URL.revokeObjectURL(objectUrl),
      height: image.naturalHeight,
      source: image,
      width: image.naturalWidth
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

function blobDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('The profile image could not be encoded.'));
    reader.onerror = () => reject(new Error('The profile image could not be encoded.'));
    reader.readAsDataURL(blob);
  });
}
