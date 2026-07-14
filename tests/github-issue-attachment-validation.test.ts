import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';

import {
  GITHUB_ISSUE_MAX_ATTACHMENT_BYTES,
  GITHUB_ISSUE_MAX_ATTACHMENT_DIMENSION,
  GITHUB_ISSUE_MAX_ATTACHMENT_PIXELS,
  GitHubIssueAttachmentValidationError,
  validateGitHubIssueAttachment
} from '../server/github-issue-attachment-validation';

const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////'
  + '2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB'
  + '/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAA'
  + 'AAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAA'
  + 'AAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgB'
  + 'AQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA'
  + '/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==',
  'base64'
);
const GIF_1X1 = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64'
);
const WEBP_1X1 = Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89',
  'base64'
);

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function makePng(
  width: number,
  height: number,
  options: { filter?: number; targetBytes?: number; compressed?: Buffer } = {}
) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const rowLength = Math.max(0, width) + 1;
  const pixels = Buffer.alloc(Math.max(0, height) * rowLength);
  for (let row = 0; row < height; row += 1) {
    pixels[row * rowLength] = options.filter ?? 0;
  }
  const imageData = options.compressed ?? deflateSync(pixels);
  const fixedChunks = [
    pngChunk('IHDR', header),
    pngChunk('IDAT', imageData),
    pngChunk('IEND', Buffer.alloc(0))
  ];
  const fixedLength = signature.length + fixedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const paddingLength = options.targetBytes === undefined ? 0 : options.targetBytes - fixedLength - 12;
  if (paddingLength < 0) {
    throw new Error('Requested PNG target size is too small.');
  }
  const padding = paddingLength === 0 ? [] : [pngChunk('ruSt', Buffer.alloc(paddingLength, 0x61))];
  return Buffer.concat([signature, fixedChunks[0], ...padding, fixedChunks[1], fixedChunks[2]]);
}

function mutatePngDimensions(bytes: Buffer, width: number, height: number) {
  const copy = Buffer.from(bytes);
  copy.writeUInt32BE(width, 16);
  copy.writeUInt32BE(height, 20);
  copy.writeUInt32BE(crc32(copy.subarray(12, 29)), 29);
  return copy;
}

function mutateJpegDimensions(bytes: Buffer, width: number, height: number) {
  const copy = Buffer.from(bytes);
  for (let offset = 2; offset < copy.length - 8; offset += 1) {
    if (copy[offset] === 0xff && copy[offset + 1] >= 0xc0 && copy[offset + 1] <= 0xcf
      && ![0xc4, 0xc8, 0xcc].includes(copy[offset + 1])) {
      copy.writeUInt16BE(height, offset + 5);
      copy.writeUInt16BE(width, offset + 7);
      return copy;
    }
  }
  throw new Error('JPEG fixture has no start-of-frame marker.');
}

async function expectInvalid(bytes: unknown, declaredMediaType: unknown) {
  try {
    await validateGitHubIssueAttachment({
      bytes: bytes as Uint8Array,
      declaredMediaType: declaredMediaType as string
    });
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubIssueAttachmentValidationError);
    expect((error as GitHubIssueAttachmentValidationError).code).toBe('invalid_attachment');
    expect((error as Error).message).toBe('The GitHub issue image is invalid.');
    return;
  }
  throw new Error('Expected an invalid GitHub issue image.');
}

describe('GitHub issue attachment validation', () => {
  test('accepts valid PNG, JPEG, and GIF images and returns safe metadata', async () => {
    await expect(validateGitHubIssueAttachment({
      bytes: makePng(2, 3),
      declaredMediaType: 'image/png'
    })).resolves.toEqual({ mediaType: 'image/png', extension: 'png', width: 2, height: 3 });
    await expect(validateGitHubIssueAttachment({
      bytes: JPEG_1X1,
      declaredMediaType: 'image/jpeg'
    })).resolves.toEqual({ mediaType: 'image/jpeg', extension: 'jpg', width: 1, height: 1 });
    await expect(validateGitHubIssueAttachment({
      bytes: GIF_1X1,
      declaredMediaType: 'image/gif'
    })).resolves.toEqual({ mediaType: 'image/gif', extension: 'gif', width: 1, height: 1 });
  });

  test('accepts an exact 10 MiB structurally valid image', async () => {
    const image = makePng(1, 1, { targetBytes: GITHUB_ISSUE_MAX_ATTACHMENT_BYTES });
    expect(image).toHaveLength(GITHUB_ISSUE_MAX_ATTACHMENT_BYTES);
    await expect(validateGitHubIssueAttachment({
      bytes: image,
      declaredMediaType: 'image/png'
    })).resolves.toMatchObject({ mediaType: 'image/png', width: 1, height: 1 });
  });

  test('rejects empty, non-byte, and over-limit input', async () => {
    await expectInvalid(Buffer.alloc(0), 'image/png');
    await expectInvalid('private-image-bytes', 'image/png');
    await expectInvalid(Buffer.alloc(GITHUB_ISSUE_MAX_ATTACHMENT_BYTES + 1), 'image/png');
  });

  test('rejects unsupported formats and declared media type spoofing', async () => {
    await expectInvalid(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png');
    await expectInvalid(WEBP_1X1, 'image/webp');
    await expectInvalid(WEBP_1X1, 'image/png');
    await expectInvalid(makePng(1, 1), 'image/jpeg');
    await expectInvalid(JPEG_1X1, 'image/png');
    await expectInvalid(GIF_1X1, 'image/jpeg');
    await expectInvalid(makePng(1, 1), 'image/PNG');
  });

  test('rejects excessive dimensions and pixel counts before decoding', async () => {
    expect(GITHUB_ISSUE_MAX_ATTACHMENT_PIXELS).toBeGreaterThan(
      GITHUB_ISSUE_MAX_ATTACHMENT_DIMENSION
    );
    await expectInvalid(
      mutatePngDimensions(makePng(1, 1), GITHUB_ISSUE_MAX_ATTACHMENT_DIMENSION + 1, 1),
      'image/png'
    );
    await expectInvalid(
      mutateJpegDimensions(JPEG_1X1, 10_000, 10_000),
      'image/jpeg'
    );
    const excessiveGif = Buffer.from(GIF_1X1);
    excessiveGif.writeUInt16LE(10_000, 6);
    excessiveGif.writeUInt16LE(10_000, 8);
    excessiveGif.writeUInt16LE(10_000, 24);
    excessiveGif.writeUInt16LE(10_000, 26);
    await expectInvalid(excessiveGif, 'image/gif');
  });

  test('rejects corrupt and truncated PNG structures and image data', async () => {
    const badCrc = Buffer.from(makePng(1, 1));
    badCrc[29] ^= 0xff;
    await expectInvalid(badCrc, 'image/png');
    await expectInvalid(makePng(1, 1, { filter: 5 }), 'image/png');
    await expectInvalid(makePng(1, 1, { compressed: Buffer.from([0x78, 0x9c, 0]) }), 'image/png');
    await expectInvalid(makePng(1, 1, {
      compressed: Buffer.concat([deflateSync(Buffer.from([0, 0])), Buffer.from([0])])
    }), 'image/png');
    await expectInvalid(makePng(1, 1).subarray(0, -1), 'image/png');
    const png = makePng(1, 1);
    const animatedPng = Buffer.concat([
      png.subarray(0, 33),
      pngChunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])),
      png.subarray(33)
    ]);
    await expectInvalid(animatedPng, 'image/png');
  });

  test('rejects corrupt and truncated JPEG and GIF structures', async () => {
    await expectInvalid(JPEG_1X1.subarray(0, -2), 'image/jpeg');
    await expectInvalid(Buffer.concat([JPEG_1X1, Buffer.from([0])]), 'image/jpeg');
    await expectInvalid(GIF_1X1.subarray(0, -1), 'image/gif');
    const badLzwCodeSize = Buffer.from(GIF_1X1);
    badLzwCodeSize[29] = 1;
    await expectInvalid(badLzwCodeSize, 'image/gif');
    const trailingGif = Buffer.concat([GIF_1X1, Buffer.from([0])]);
    await expectInvalid(trailingGif, 'image/gif');
    const missingColorTable = Buffer.concat([GIF_1X1.subarray(0, 13), GIF_1X1.subarray(19)]);
    missingColorTable[10] &= 0x7f;
    await expectInvalid(missingColorTable, 'image/gif');
    const invalidGraphicControl = Buffer.concat([
      GIF_1X1.subarray(0, 19),
      Buffer.from([0x21, 0xf9, 0x04, 0xe0, 0, 0, 0, 0]),
      GIF_1X1.subarray(19)
    ]);
    await expectInvalid(invalidGraphicControl, 'image/gif');
    const animatedGif = Buffer.concat([
      GIF_1X1.subarray(0, -1),
      GIF_1X1.subarray(19, -1),
      Buffer.from([0x3b])
    ]);
    await expectInvalid(animatedGif, 'image/gif');
  });

  test('returns the same non-sensitive error for rejected content', async () => {
    const sensitive = Buffer.from('private-image-secret-token');
    try {
      await validateGitHubIssueAttachment({ bytes: sensitive, declaredMediaType: 'image/png' });
      throw new Error('Expected rejection.');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubIssueAttachmentValidationError);
      expect(String(error)).not.toContain('private-image-secret-token');
    }
  });
});
