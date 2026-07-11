import { inflateSync } from 'node:zlib';
import { ProjectChatError } from './contracts';

export const PROJECT_CHAT_MAX_AVATAR_BYTES = 256 * 1024;
export const PROJECT_CHAT_MAX_AVATAR_DIMENSION = 1024;
const PROJECT_CHAT_MAX_PROVIDER_AVATAR_URL_LENGTH = 2048;
const MAX_ENCODED_AVATAR_LENGTH = Math.ceil(PROJECT_CHAT_MAX_AVATAR_BYTES / 3) * 4;
const MAX_DATA_URL_LENGTH = 'data:image/jpeg;base64,'.length + MAX_ENCODED_AVATAR_LENGTH;
const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START_OF_FRAME_MARKERS = new Set(
  [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
);
interface ImageDimensions { width: number; height: number }
function invalidAvatar(): never {
  throw new ProjectChatError('invalid_request', 'The Project Chat avatar is invalid.');
}

function validDimensions({ width, height }: ImageDimensions) {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width >= 1
    && height >= 1
    && width <= PROJECT_CHAT_MAX_AVATAR_DIMENSION
    && height <= PROJECT_CHAT_MAX_AVATAR_DIMENSION;
}

export function normalizeProjectChatProviderAvatarUrl(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length > PROJECT_CHAT_MAX_PROVIDER_AVATAR_URL_LENGTH) {
    return undefined;
  }

  const candidate = value.trim();
  if (
    candidate.length === 0
    || /[\u0000-\u0020\u007f\\]/.test(candidate)
    || candidate.includes('#')
  ) {
    return undefined;
  }

  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || url.hostname === ''
      || url.href.length > PROJECT_CHAT_MAX_PROVIDER_AVATAR_URL_LENGTH
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}
export function parseProjectChatAvatarDataUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_DATA_URL_LENGTH) {
    invalidAvatar();
  }

  const match = DATA_URL_PATTERN.exec(value);
  if (match === null) {
    invalidAvatar();
  }

  const [, mediaType, encoded] = match;
  if (encoded.length === 0 || encoded.length % 4 !== 0 || encoded.length > MAX_ENCODED_AVATAR_LENGTH) {
    invalidAvatar();
  }

  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length === 0
    || bytes.length > PROJECT_CHAT_MAX_AVATAR_BYTES
    || bytes.toString('base64') !== encoded
  ) {
    invalidAvatar();
  }

  try {
    const dimensions = mediaType === 'image/png' ? readPngDimensions(bytes)
      : mediaType === 'image/jpeg' ? readJpegDimensions(bytes)
        : readWebpDimensions(bytes);
    if (dimensions === null || !validDimensions(dimensions)) {
      invalidAvatar();
    }
  } catch (error) {
    if (error instanceof ProjectChatError) {
      throw error;
    }
    invalidAvatar();
  }

  return value;
}

function readPngDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 57 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }

  let offset = PNG_SIGNATURE.length;
  let dimensions: ImageDimensions | null = null;
  let bitDepth = 0;
  let colorType = -1;
  let interlaceMethod = -1;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataClosed = false;
  const imageData: Buffer[] = [];

  while (offset < bytes.length) {
    if (bytes.length - offset < 12) {
      return null;
    }
    const chunkLength = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    if (chunkLength > bytes.length - dataStart - 4) {
      return null;
    }
    const dataEnd = dataStart + chunkLength;
    const chunkEnd = dataEnd + 4;
    const chunkType = bytes.toString('ascii', typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(chunkType) || (bytes[typeStart + 2] & 0x20) !== 0) {
      return null;
    }
    if (crc32(bytes, typeStart, dataEnd) !== bytes.readUInt32BE(dataEnd)) {
      return null;
    }

    if (dimensions === null && chunkType !== 'IHDR') {
      return null;
    }
    switch (chunkType) {
      case 'IHDR': {
        if (dimensions !== null || offset !== PNG_SIGNATURE.length || chunkLength !== 13) {
          return null;
        }
        dimensions = {
          width: bytes.readUInt32BE(dataStart),
          height: bytes.readUInt32BE(dataStart + 4)
        };
        bitDepth = bytes[dataStart + 8];
        colorType = bytes[dataStart + 9];
        interlaceMethod = bytes[dataStart + 12];
        if (
          !validDimensions(dimensions)
          || !validPngColorFormat(bitDepth, colorType)
          || bytes[dataStart + 10] !== 0
          || bytes[dataStart + 11] !== 0
          || (interlaceMethod !== 0 && interlaceMethod !== 1)
        ) {
          return null;
        }
        break;
      }
      case 'PLTE':
        if (sawPalette || sawImageData || chunkLength === 0 || chunkLength % 3 !== 0 || chunkLength > 768) {
          return null;
        }
        sawPalette = true;
        break;
      case 'IDAT':
        if (imageDataClosed) {
          return null;
        }
        sawImageData = true;
        imageData.push(bytes.subarray(dataStart, dataEnd));
        break;
      case 'IEND': {
        if (
          chunkLength !== 0
          || !sawImageData
          || chunkEnd !== bytes.length
          || dimensions === null
          || (colorType === 3 && !sawPalette)
          || ((colorType === 0 || colorType === 4) && sawPalette)
        ) {
          return null;
        }
        return validPngImageData(
          Buffer.concat(imageData), dimensions, bitDepth, colorType, interlaceMethod
        ) ? dimensions : null;
      }
      default:
        if ((bytes[typeStart] & 0x20) === 0) {
          return null;
        }
        if (sawImageData) {
          imageDataClosed = true;
        }
    }

    offset = chunkEnd;
  }
  return null;
}
function validPngColorFormat(bitDepth: number, colorType: number) {
  const supportedDepths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16]
  };
  return supportedDepths[colorType]?.includes(bitDepth) === true;
}

function validPngImageData(
  compressed: Buffer,
  dimensions: ImageDimensions,
  bitDepth: number,
  colorType: number,
  interlaceMethod: number
) {
  if (compressed.length === 0) {
    return false;
  }
  const channels = colorType === 0 || colorType === 3 ? 1
    : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const bitsPerPixel = channels * bitDepth;
  const passes = interlaceMethod === 0
    ? [{ width: dimensions.width, height: dimensions.height }]
    : adam7Passes(dimensions);
  const layouts = passes
    .filter((pass) => pass.width > 0 && pass.height > 0)
    .map((pass) => ({
      height: pass.height,
      rowLength: 1 + Math.ceil(pass.width * bitsPerPixel / 8)
    }));
  const expectedLength = layouts.reduce((total, layout) => total + layout.height * layout.rowLength, 0);
  const inflated = inflateSync(compressed, { maxOutputLength: expectedLength });
  if (inflated.length !== expectedLength) {
    return false;
  }

  let offset = 0;
  for (const layout of layouts) {
    for (let row = 0; row < layout.height; row += 1) {
      if (inflated[offset] > 4) {
        return false;
      }
      offset += layout.rowLength;
    }
  }
  return offset === inflated.length;
}

function adam7Passes({ width, height }: ImageDimensions) {
  const definitions = [
    [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
    [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]
  ] as const;
  return definitions.map(([startX, startY, stepX, stepY]) => ({
    width: width <= startX ? 0 : Math.ceil((width - startX) / stepX),
    height: height <= startY ? 0 : Math.ceil((height - startY) / stepY)
  }));
}

function crc32(bytes: Uint8Array, start: number, end: number) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readJpegDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 14 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  let dimensions: ImageDimensions | null = null;
  let sawScan = false;
  let entropyBytes = 0;
  while (offset < bytes.length) {
    const marker = readJpegMarker(bytes, offset);
    if (marker === null) {
      return null;
    }
    offset = marker.nextOffset;
    if (marker.code === 0xd9) {
      return offset === bytes.length && dimensions !== null && sawScan && entropyBytes > 0
        ? dimensions
        : null;
    }
    if (marker.code === 0xd8 || marker.code === 0x00 || (marker.code >= 0xd0 && marker.code <= 0xd7)) {
      return null;
    }
    if (marker.code === 0x01) {
      continue;
    }
    if (bytes.length - offset < 2) {
      return null;
    }
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || segmentLength > bytes.length - offset) {
      return null;
    }
    const dataStart = offset + 2;
    const segmentEnd = offset + segmentLength;

    if (JPEG_START_OF_FRAME_MARKERS.has(marker.code)) {
      if (dimensions !== null || segmentLength < 11) {
        return null;
      }
      const componentCount = bytes[dataStart + 5];
      dimensions = {
        height: bytes.readUInt16BE(dataStart + 1),
        width: bytes.readUInt16BE(dataStart + 3)
      };
      if (
        (bytes[dataStart] !== 8 && bytes[dataStart] !== 12)
        || componentCount < 1
        || componentCount > 4
        || segmentLength !== 8 + componentCount * 3
        || !validDimensions(dimensions)
      ) {
        return null;
      }
    }

    if (marker.code === 0xda) {
      if (dimensions === null || segmentLength < 8) {
        return null;
      }
      const componentCount = bytes[dataStart];
      if (componentCount < 1 || componentCount > 4 || segmentLength !== 6 + componentCount * 2) {
        return null;
      }
      sawScan = true;
      const nextMarker = findJpegMarkerAfterScan(bytes, segmentEnd);
      if (nextMarker === null) {
        return null;
      }
      entropyBytes += nextMarker - segmentEnd;
      offset = nextMarker;
    } else {
      offset = segmentEnd;
    }
  }
  return null;
}

function readJpegMarker(bytes: Buffer, offset: number) {
  if (bytes[offset] !== 0xff) {
    return null;
  }
  while (offset < bytes.length && bytes[offset] === 0xff) {
    offset += 1;
  }
  if (offset >= bytes.length) {
    return null;
  }
  return { code: bytes[offset], nextOffset: offset + 1 };
}

function findJpegMarkerAfterScan(bytes: Buffer, offset: number) {
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const markerOffset = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) {
      return null;
    }
    const code = bytes[offset];
    if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) {
      offset += 1;
      continue;
    }
    return markerOffset;
  }
  return null;
}

function readWebpDimensions(bytes: Buffer): ImageDimensions | null {
  if (
    bytes.length < 30
    || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.readUInt32LE(4) !== bytes.length - 8
    || bytes.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }

  let offset = 12;
  let chunkIndex = 0;
  let extendedDimensions: ImageDimensions | null = null;
  let imageDimensions: ImageDimensions | null = null;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) {
      return null;
    }
    const chunkType = bytes.toString('ascii', offset, offset + 4);
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkLength > bytes.length - dataStart) {
      return null;
    }
    const dataEnd = dataStart + chunkLength;
    const chunkEnd = dataEnd + (chunkLength & 1);
    if (chunkEnd > bytes.length || (chunkLength & 1) === 1 && bytes[dataEnd] !== 0) {
      return null;
    }

    if (chunkIndex === 0 && chunkType === 'VP8X') {
      if (chunkLength !== 10 || (bytes[dataStart] & 0xc3) !== 0) {
        return null;
      }
      extendedDimensions = {
        width: 1 + readUInt24LE(bytes, dataStart + 4),
        height: 1 + readUInt24LE(bytes, dataStart + 7)
      };
      if (!validDimensions(extendedDimensions)) {
        return null;
      }
    } else if (chunkType === 'VP8 ' || chunkType === 'VP8L') {
      if (imageDimensions !== null || (extendedDimensions === null && chunkIndex !== 0)) {
        return null;
      }
      imageDimensions = chunkType === 'VP8 '
        ? readVp8Dimensions(bytes.subarray(dataStart, dataEnd))
        : readVp8lDimensions(bytes.subarray(dataStart, dataEnd));
      if (imageDimensions === null || !validDimensions(imageDimensions)) {
        return null;
      }
    } else if (extendedDimensions === null || chunkType === 'ANIM' || chunkType === 'ANMF') {
      return null;
    }

    chunkIndex += 1;
    offset = chunkEnd;
  }

  if (offset !== bytes.length || imageDimensions === null) {
    return null;
  }
  if (extendedDimensions === null) {
    return chunkIndex === 1 ? imageDimensions : null;
  }
  return extendedDimensions.width === imageDimensions.width
    && extendedDimensions.height === imageDimensions.height
    ? extendedDimensions
    : null;
}

function readVp8Dimensions(bytes: Buffer): ImageDimensions | null {
  if (
    bytes.length < 10
    || (bytes[0] & 1) !== 0
    || bytes[3] !== 0x9d
    || bytes[4] !== 0x01
    || bytes[5] !== 0x2a
  ) {
    return null;
  }
  const frameTag = bytes[0] | bytes[1] << 8 | bytes[2] << 16;
  const firstPartitionLength = frameTag >>> 5;
  if (firstPartitionLength > bytes.length - 10) {
    return null;
  }
  return {
    width: bytes.readUInt16LE(6) & 0x3fff,
    height: bytes.readUInt16LE(8) & 0x3fff
  };
}

function readVp8lDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 6 || bytes[0] !== 0x2f) {
    return null;
  }
  const header = bytes.readUInt32LE(1);
  if ((header >>> 29) !== 0) {
    return null;
  }
  return {
    width: 1 + (header & 0x3fff),
    height: 1 + (header >>> 14 & 0x3fff)
  };
}

function readUInt24LE(bytes: Buffer, offset: number) {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
}
