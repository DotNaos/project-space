import { inflateSync } from 'node:zlib';

import type { HostConsoleFrame } from '../../src/shared/host-control-api';

const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;

export function validFrame(frame: HostConsoleFrame, now: Date) {
  const capturedAt = Date.parse(frame.capturedAt);
  const staleAfter = Date.parse(frame.staleAfter);
  const dimensions = pngDimensions(frame.png);
  return operationIdPattern.test(frame.frameId) && dimensions?.width === frame.width &&
    dimensions.height === frame.height && Number.isFinite(capturedAt) && Number.isFinite(staleAfter) &&
    capturedAt <= now.getTime() && capturedAt < staleAfter && staleAfter > now.getTime();
}

export function pngDimensions(bytes: Uint8Array) {
  if (bytes.length < 57 || bytes.length > 16 * 1024 * 1024 ||
    !Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return undefined;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitsPerPixel = 0;
  let colorType = 0;
  let sawHeader = false;
  let sawData = false;
  let dataEnded = false;
  let sawPalette = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = Buffer.from(bytes).readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return undefined;
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('ascii');
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = Buffer.from(bytes).readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) return undefined;
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return undefined;
      width = Buffer.from(payload).readUInt32BE(0);
      height = Buffer.from(payload).readUInt32BE(4);
      const bitDepth = payload[8]!;
      colorType = payload[9]!;
      const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1
        : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
      const validDepth = colorType === 3 ? [1, 2, 4, 8].includes(bitDepth)
        : colorType === 0 ? [1, 2, 4, 8, 16].includes(bitDepth)
          : [8, 16].includes(bitDepth);
      if (!width || !height || width > 7680 || height > 4320 || !channels || !validDepth ||
        payload[10] !== 0 || payload[11] !== 0 || payload[12] !== 0) return undefined;
      bitsPerPixel = channels * bitDepth;
      sawHeader = true;
    } else if (type === 'PLTE') {
      if (sawPalette || sawData || !length || length % 3 !== 0 || length > 768) return undefined;
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (dataEnded) return undefined;
      sawData = true;
      data.push(Buffer.from(payload));
    } else if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length || !sawData || colorType === 3 && !sawPalette) return undefined;
      const expectedLength = height * (1 + Math.ceil(width * bitsPerPixel / 8));
      let decoded: Buffer;
      try {
        decoded = inflateSync(Buffer.concat(data), { maxOutputLength: expectedLength + 1 });
      } catch {
        return undefined;
      }
      if (decoded.length !== expectedLength) return undefined;
      const rowLength = 1 + Math.ceil(width * bitsPerPixel / 8);
      for (let row = 0; row < height; row += 1) if (decoded[row * rowLength]! > 4) return undefined;
      return { height, width };
    } else {
      if (type === 'IHDR' || isCriticalChunk(type)) return undefined;
      if (sawData) dataEnded = true;
    }
    offset = end;
  }
  return undefined;
}

function isCriticalChunk(type: string) {
  return type.length !== 4 || type.charCodeAt(0) < 97;
}

export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
