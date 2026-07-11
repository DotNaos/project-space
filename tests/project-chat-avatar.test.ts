import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';

import {
  PROJECT_CHAT_MAX_AVATAR_BYTES,
  PROJECT_CHAT_MAX_AVATAR_DIMENSION,
  normalizeProjectChatProviderAvatarUrl,
  parseProjectChatAvatarDataUrl
} from '../server/project-chat/avatar';
import { ProjectChatError } from '../server/project-chat/contracts';

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
const WEBP_1X1 = Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89',
  'base64'
);
const WEBP_LOSSLESS_1X1 = Buffer.from(
  'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
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
  options: { filter?: number; targetBytes?: number } = {}
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
  const fixedChunks = [
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
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

function dataUrl(mediaType: 'image/png' | 'image/jpeg' | 'image/webp', bytes: Buffer) {
  return `data:${mediaType};base64,${bytes.toString('base64')}`;
}

function expectInvalid(value: unknown) {
  try {
    parseProjectChatAvatarDataUrl(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectChatError);
    expect((error as ProjectChatError).code).toBe('invalid_request');
    expect((error as Error).message).toBe('The Project Chat avatar is invalid.');
    return;
  }
  throw new Error('Expected an invalid Project Chat avatar.');
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

describe('Project Chat provider avatar URL normalization', () => {
  test('normalizes safe HTTPS provider URLs', () => {
    expect(normalizeProjectChatProviderAvatarUrl(undefined)).toBeUndefined();
    expect(normalizeProjectChatProviderAvatarUrl(
      '  HTTPS://avatars.githubusercontent.com:443/u/123?v=4  '
    )).toBe('https://avatars.githubusercontent.com/u/123?v=4');
    expect(normalizeProjectChatProviderAvatarUrl(
      'https://cdn.example.test/avatar%20image.png?size=256'
    )).toBe('https://cdn.example.test/avatar%20image.png?size=256');
  });

  test('accepts the exact URL length limit and rejects one character more', () => {
    const prefix = 'https://example.test/';
    const atLimit = prefix + 'a'.repeat(2048 - prefix.length);
    expect(normalizeProjectChatProviderAvatarUrl(atLimit)).toBe(atLimit);
    expect(normalizeProjectChatProviderAvatarUrl(`${atLimit}a`)).toBeUndefined();
    expect(normalizeProjectChatProviderAvatarUrl(` ${atLimit} `)).toBeUndefined();
  });

  test.each([
    '',
    'not a URL',
    'http://avatars.example.test/person.png',
    'data:image/png;base64,AAAA',
    'https://user@example.test/person.png',
    'https://user:password@example.test/person.png',
    'https://example.test/person.png#face',
    'https://example.test/person.png#',
    'https://example.test\\@attacker.test/person.png',
    'https://example.test/person\n.png'
  ])('drops unsafe provider URL %s', (value) => {
    expect(normalizeProjectChatProviderAvatarUrl(value)).toBeUndefined();
  });

  test('drops unexpected runtime input instead of throwing', () => {
    expect(normalizeProjectChatProviderAvatarUrl(null as never)).toBeUndefined();
  });
});

describe('Project Chat avatar data URLs', () => {
  const png = dataUrl('image/png', makePng(1, 1));
  const jpeg = dataUrl('image/jpeg', JPEG_1X1);
  const webp = dataUrl('image/webp', WEBP_1X1);

  test.each([
    ['PNG', png],
    ['JPEG', jpeg],
    ['WebP', webp],
    ['lossless WebP', dataUrl('image/webp', WEBP_LOSSLESS_1X1)]
  ])('accepts a valid minimal %s fixture', (_name, value) => {
    expect(parseProjectChatAvatarDataUrl(value)).toBe(value);
  });

  test('accepts images at the dimension and decoded-byte boundaries', () => {
    const maxDimension = dataUrl(
      'image/png',
      makePng(PROJECT_CHAT_MAX_AVATAR_DIMENSION, PROJECT_CHAT_MAX_AVATAR_DIMENSION)
    );
    const maxBytes = dataUrl('image/png', makePng(1, 1, {
      targetBytes: PROJECT_CHAT_MAX_AVATAR_BYTES
    }));
    expect(parseProjectChatAvatarDataUrl(maxDimension)).toBe(maxDimension);
    expect(Buffer.from(maxBytes.split(',')[1], 'base64')).toHaveLength(PROJECT_CHAT_MAX_AVATAR_BYTES);
    expect(parseProjectChatAvatarDataUrl(maxBytes)).toBe(maxBytes);
  });

  test.each([
    undefined,
    null,
    1,
    {},
    Buffer.from('avatar')
  ])('rejects non-string input %#', (value) => {
    expectInvalid(value);
  });

  test.each([
    'data:image/PNG;base64,AAAA',
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
    'data:image/png;charset=utf-8;base64,AAAA',
    'data:image/png;BASE64,AAAA',
    'data:image/png;base64,',
    'data:image/png;base64,AA==\n',
    'data:image/png;base64,AA',
    'data:image/png;base64,AB==',
    'data:image/png;base64,____'
  ])('rejects a non-canonical data URL %s', (value) => {
    expectInvalid(value);
  });

  test('rejects missing or extra Base64 padding and embedded whitespace', () => {
    expectInvalid(png.replace(/=+$/, ''));
    expectInvalid(`${png}=`);
    expectInvalid(png.replace(',', ',\n'));
  });

  test('rejects SVG and valid images renamed to another media type', () => {
    expectInvalid(dataUrl('image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')));
    expectInvalid(dataUrl('image/jpeg', makePng(1, 1)));
    expectInvalid(dataUrl('image/webp', JPEG_1X1));
    expectInvalid(dataUrl('image/png', WEBP_1X1));
  });

  test('rejects zero and excessive dimensions', () => {
    for (const [width, height] of [
      [0, 1],
      [1, 0],
      [PROJECT_CHAT_MAX_AVATAR_DIMENSION + 1, 1],
      [1, PROJECT_CHAT_MAX_AVATAR_DIMENSION + 1]
    ]) {
      expectInvalid(dataUrl('image/png', makePng(width, height)));
    }
    expectInvalid(dataUrl('image/jpeg', mutateJpegDimensions(
      JPEG_1X1,
      PROJECT_CHAT_MAX_AVATAR_DIMENSION + 1,
      1
    )));
    const oversizedWebp = Buffer.from(WEBP_1X1);
    oversizedWebp.writeUInt16LE(PROJECT_CHAT_MAX_AVATAR_DIMENSION + 1, 26);
    expectInvalid(dataUrl('image/webp', oversizedWebp));
  });

  test('rejects decoded images over the byte limit before parsing', () => {
    const oversized = makePng(1, 1, { targetBytes: PROJECT_CHAT_MAX_AVATAR_BYTES + 1 });
    expect(oversized).toHaveLength(PROJECT_CHAT_MAX_AVATAR_BYTES + 1);
    expectInvalid(dataUrl('image/png', oversized));
  });

  test('rejects corrupt and truncated image structures', () => {
    const badPngCrc = Buffer.from(makePng(1, 1));
    badPngCrc[29] ^= 0xff;
    expectInvalid(dataUrl('image/png', badPngCrc));
    expectInvalid(dataUrl('image/png', makePng(1, 1, { filter: 5 })));
    expectInvalid(dataUrl('image/png', makePng(1, 1).subarray(0, -1)));
    expectInvalid(dataUrl('image/jpeg', JPEG_1X1.subarray(0, -2)));
    expectInvalid(dataUrl('image/jpeg', Buffer.concat([JPEG_1X1, Buffer.from([0])] )));
    const badWebpLength = Buffer.from(WEBP_1X1);
    badWebpLength.writeUInt32LE(badWebpLength.length, 4);
    expectInvalid(dataUrl('image/webp', badWebpLength));
    expectInvalid(dataUrl('image/webp', WEBP_1X1.subarray(0, -1)));
  });

  test('never includes rejected content in its public error', () => {
    const sensitive = 'data:image/png;base64,secret-private-value';
    try {
      parseProjectChatAvatarDataUrl(sensitive);
      throw new Error('Expected rejection.');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectChatError);
      expect((error as ProjectChatError).code).toBe('invalid_request');
      expect((error as Error).message).not.toContain('secret-private-value');
    }
  });
});
