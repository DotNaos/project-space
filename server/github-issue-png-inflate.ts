import { inflate } from 'node:zlib';

interface PngInflateResult {
  buffer: Buffer;
  bytesWritten: number;
}

export function inflatePngImageData(
  compressed: Buffer,
  maximumOutputBytes: number
): Promise<PngInflateResult> {
  return new Promise((resolve, reject) => {
    inflate(
      compressed,
      { info: true, maxOutputLength: maximumOutputBytes },
      (error, output) => {
        if (error) {
          reject(error);
          return;
        }
        const result = output as unknown as {
          buffer: Buffer;
          engine: { bytesWritten: number };
        };
        resolve({ buffer: result.buffer, bytesWritten: result.engine.bytesWritten });
      }
    );
  });
}
