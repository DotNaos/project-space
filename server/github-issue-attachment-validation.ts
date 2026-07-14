import { crc32 } from 'node:zlib';

import { inflatePngImageData } from './github-issue-png-inflate';

export const GITHUB_ISSUE_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const GITHUB_ISSUE_MAX_ATTACHMENT_DIMENSION = 16_384;
export const GITHUB_ISSUE_MAX_ATTACHMENT_PIXELS = 64 * 1024 * 1024;

const MAX_PNG_SCANLINE_BYTES = 64 * 1024 * 1024;
const MAX_STRUCTURE_PARTS = 100_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START_OF_FRAME_MARKERS = new Set(
  [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
);
export type GitHubIssueAttachmentMediaType = 'image/png' | 'image/jpeg' | 'image/gif';

export interface ValidatedGitHubIssueAttachment extends ImageDimensions {
  mediaType: GitHubIssueAttachmentMediaType;
  extension: 'png' | 'jpg' | 'gif';
}
interface ImageDimensions { width: number; height: number }
interface PngScanlineLayout { height: number; rowLength: number }
interface ParsedPng extends ImageDimensions { compressed: Buffer; layouts: PngScanlineLayout[] }

export class GitHubIssueAttachmentValidationError extends Error {
  readonly code = 'invalid_attachment';
  constructor() {
    super('The GitHub issue image is invalid.');
    this.name = 'GitHubIssueAttachmentValidationError';
  }
}
function invalidAttachment(): never {
  throw new GitHubIssueAttachmentValidationError();
}

export async function validateGitHubIssueAttachment(input: {
  bytes: Uint8Array;
  declaredMediaType: string;
}): Promise<ValidatedGitHubIssueAttachment> {
  if (
    input === null
    || typeof input !== 'object'
    || !(input.bytes instanceof Uint8Array)
    || input.bytes.byteLength === 0
    || input.bytes.byteLength > GITHUB_ISSUE_MAX_ATTACHMENT_BYTES
    || !isSupportedMediaType(input.declaredMediaType)
  ) {
    invalidAttachment();
  }
  const bytes = Buffer.from(input.bytes);
  const detectedMediaType = detectMediaType(bytes);
  if (detectedMediaType !== input.declaredMediaType) {
    invalidAttachment();
  }
  try {
    if (detectedMediaType === 'image/png') {
      const parsed = readPng(bytes);
      if (parsed === null || !await validPngImageData(parsed)) {
        invalidAttachment();
      }
      return { mediaType: detectedMediaType, extension: 'png', width: parsed.width, height: parsed.height };
    }
    if (detectedMediaType === 'image/jpeg') {
      const dimensions = readJpegDimensions(bytes);
      if (dimensions === null) {
        invalidAttachment();
      }
      return { mediaType: detectedMediaType, extension: 'jpg', ...dimensions };
    }
    if (detectedMediaType === 'image/gif') {
      const dimensions = readGifDimensions(bytes);
      if (dimensions === null) {
        invalidAttachment();
      }
      return { mediaType: detectedMediaType, extension: 'gif', ...dimensions };
    }
  } catch (error) {
    if (error instanceof GitHubIssueAttachmentValidationError) {
      throw error;
    }
    invalidAttachment();
  }
  invalidAttachment();
}
function isSupportedMediaType(value: unknown): value is GitHubIssueAttachmentMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/gif';
}
function detectMediaType(bytes: Buffer): GitHubIssueAttachmentMediaType | null {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg';
  }
  const header = bytes.length >= 6 ? bytes.toString('ascii', 0, 6) : '';
  return header === 'GIF87a' || header === 'GIF89a' ? 'image/gif' : null;
}
function validDimensions({ width, height }: ImageDimensions) {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width >= 1
    && height >= 1
    && width <= GITHUB_ISSUE_MAX_ATTACHMENT_DIMENSION
    && height <= GITHUB_ISSUE_MAX_ATTACHMENT_DIMENSION
    && width * height <= GITHUB_ISSUE_MAX_ATTACHMENT_PIXELS;
}
function readPng(bytes: Buffer): ParsedPng | null {
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
  let partCount = 0;
  const imageData: Buffer[] = [];
  while (offset < bytes.length && partCount < MAX_STRUCTURE_PARTS) {
    partCount += 1;
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
    if (crc32(bytes.subarray(typeStart, dataEnd)) !== bytes.readUInt32BE(dataEnd)) {
      return null;
    }
    if (dimensions === null && chunkType !== 'IHDR') {
      return null;
    }
    if (sawImageData && chunkType !== 'IDAT' && chunkType !== 'IEND') {
      imageDataClosed = true;
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
      case 'PLTE': {
        const entryCount = chunkLength / 3;
        if (
          sawPalette
          || sawImageData
          || chunkLength === 0
          || chunkLength % 3 !== 0
          || chunkLength > 768
          || colorType === 0
          || colorType === 4
          || (colorType === 3 && entryCount > 2 ** bitDepth)
        ) {
          return null;
        }
        sawPalette = true;
        break;
      }
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
        ) {
          return null;
        }
        const layouts = pngScanlineLayouts(dimensions, bitDepth, colorType, interlaceMethod);
        const compressed = Buffer.concat(imageData);
        return layouts === null || compressed.length === 0
          ? null
          : { ...dimensions, compressed, layouts };
      }
      default:
        if (chunkType === 'acTL' || chunkType === 'fcTL' || chunkType === 'fdAT') {
          return null;
        }
        if ((bytes[typeStart] & 0x20) === 0) {
          return null;
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
function pngScanlineLayouts(
  dimensions: ImageDimensions,
  bitDepth: number,
  colorType: number,
  interlaceMethod: number
): PngScanlineLayout[] | null {
  const channels = colorType === 0 || colorType === 3 ? 1
    : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const bitsPerPixel = channels * bitDepth;
  const passes = interlaceMethod === 0
    ? [dimensions]
    : adam7Passes(dimensions);
  const layouts = passes
    .filter((pass) => pass.width > 0 && pass.height > 0)
    .map((pass) => ({
      height: pass.height,
      rowLength: 1 + Math.ceil(pass.width * bitsPerPixel / 8)
    }));
  const decodedBytes = layouts.reduce((total, layout) => total + layout.height * layout.rowLength, 0);
  return decodedBytes > 0 && decodedBytes <= MAX_PNG_SCANLINE_BYTES ? layouts : null;
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
async function validPngImageData({ compressed, layouts }: ParsedPng) {
  const expectedBytes = layouts.reduce((total, layout) => total + layout.height * layout.rowLength, 0);
  const result = await inflatePngImageData(compressed, expectedBytes);
  const inflated = result.buffer;
  if (inflated.length !== expectedBytes || result.bytesWritten !== compressed.length) {
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
function readJpegDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 14 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  let dimensions: ImageDimensions | null = null;
  let sawScan = false;
  let entropyBytes = 0;
  let parts = 0;
  while (offset < bytes.length && parts < MAX_STRUCTURE_PARTS) {
    parts += 1;
    const marker = readJpegMarker(bytes, offset);
    if (marker === null) {
      return null;
    }
    offset = marker.nextOffset;
    if (marker.code === 0xd9) {
      return offset === bytes.length && dimensions !== null && sawScan && entropyBytes > 0
        ? dimensions : null;
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
  return offset < bytes.length ? { code: bytes[offset], nextOffset: offset + 1 } : null;
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
function readGifDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 14) {
    return null;
  }
  const dimensions = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (!validDimensions(dimensions)) {
    return null;
  }
  const hasGlobalColorTable = (bytes[10] & 0x80) !== 0;
  const globalColorTableBytes = !hasGlobalColorTable
    ? 0 : 3 * 2 ** ((bytes[10] & 0x07) + 1);
  let offset = 13 + globalColorTableBytes;
  let sawImage = false;
  const parts = { count: 0 };
  if (offset > bytes.length) {
    return null;
  }
  while (offset < bytes.length && parts.count < MAX_STRUCTURE_PARTS) {
    parts.count += 1;
    const introducer = bytes[offset];
    offset += 1;
    if (introducer === 0x3b) {
      return offset === bytes.length && sawImage ? dimensions : null;
    }
    if (introducer === 0x21) {
      if (offset >= bytes.length) {
        return null;
      }
      const label = bytes[offset];
      offset += 1;
      const extensionEnd = skipGifExtension(bytes, offset, label, parts);
      if (extensionEnd === null) {
        return null;
      }
      offset = extensionEnd;
      continue;
    }
    if (introducer !== 0x2c || bytes.length - offset < 9) {
      return null;
    }
    if (sawImage) {
      return null;
    }
    const left = bytes.readUInt16LE(offset);
    const top = bytes.readUInt16LE(offset + 2);
    const width = bytes.readUInt16LE(offset + 4);
    const height = bytes.readUInt16LE(offset + 6);
    const packed = bytes[offset + 8];
    if (
      width === 0
      || height === 0
      || left + width > dimensions.width
      || top + height > dimensions.height
      || (packed & 0x18) !== 0
    ) {
      return null;
    }
    offset += 9;
    const hasLocalColorTable = (packed & 0x80) !== 0;
    if (!hasGlobalColorTable && !hasLocalColorTable) {
      return null;
    }
    const localColorTableBytes = !hasLocalColorTable ? 0 : 3 * 2 ** ((packed & 0x07) + 1);
    offset += localColorTableBytes;
    if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) {
      return null;
    }
    offset += 1;
    const imageDataEnd = skipGifSubBlocks(bytes, offset, parts, true);
    if (imageDataEnd === null) {
      return null;
    }
    offset = imageDataEnd;
    sawImage = true;
  }
  return null;
}
function skipGifExtension(
  bytes: Buffer,
  offset: number,
  label: number,
  parts: { count: number }
) {
  if (label === 0xf9) {
    return bytes.length - offset >= 6
      && bytes[offset] === 4
      && (bytes[offset + 1] & 0xe0) === 0
      && bytes[offset + 5] === 0
      ? offset + 6 : null;
  }
  if (label === 0xff || label === 0x01) {
    const requiredHeaderLength = label === 0xff ? 11 : 12;
    if (offset >= bytes.length || bytes[offset] !== requiredHeaderLength) {
      return null;
    }
    offset += 1 + requiredHeaderLength;
  }
  return skipGifSubBlocks(bytes, offset, parts, false);
}
function skipGifSubBlocks(
  bytes: Buffer,
  offset: number,
  parts: { count: number },
  requireData: boolean
) {
  let sawData = false;
  while (offset < bytes.length && parts.count < MAX_STRUCTURE_PARTS) {
    parts.count += 1;
    const length = bytes[offset];
    offset += 1;
    if (length === 0) {
      return requireData && !sawData ? null : offset;
    }
    sawData = true;
    if (length > bytes.length - offset) {
      return null;
    }
    offset += length;
  }
  return null;
}
