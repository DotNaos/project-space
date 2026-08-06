import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';

export type UnixWebSocketData = Buffer;

const connectingState = 0;
const openState = 1;
const closingState = 2;
const closedState = 3;
const websocketMagic = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const maximumHandshakeBytes = 16 * 1024;

export class UnixWebSocket extends EventEmitter {
  static readonly CONNECTING = connectingState;
  static readonly OPEN = openState;
  static readonly CLOSING = closingState;
  static readonly CLOSED = closedState;

  private frameBuffer = Buffer.alloc(0);
  private fragmentedChunks: Buffer[] = [];
  private fragmentedBytes = 0;
  private fragmentedOpcode?: number;
  private handshakeBuffer = Buffer.alloc(0);
  private readonly handshakeKey = randomBytes(16).toString('base64');
  private socket?: Socket;
  private closeEmitted = false;

  readyState = connectingState;

  constructor(
    socketPath: string,
    private readonly maximumMessageBytes: number
  ) {
    super();
    this.socket = connect({ path: socketPath });
    this.socket.once('connect', () => this.beginHandshake());
    this.socket.on('data', (data) => this.handleData(data));
    this.socket.once('error', (error) => this.fail(error));
    this.socket.once('close', () => this.finishClose());
  }

  send(
    data: string | Buffer,
    callback?: (error?: Error) => void
  ) {
    if (this.readyState !== openState || !this.socket) {
      callback?.(new Error('WebSocket is not open.'));
      return;
    }
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    if (payload.byteLength > this.maximumMessageBytes) {
      callback?.(new Error('WebSocket message exceeds the configured limit.'));
      return;
    }
    this.socket.write(
      maskedFrame(Buffer.isBuffer(data) ? 0x2 : 0x1, payload),
      (error) => callback?.(error ?? undefined)
    );
  }

  close() {
    if (this.readyState === closedState || this.readyState === closingState) return;
    if (this.readyState === connectingState) {
      this.readyState = closingState;
      this.socket?.destroy();
      return;
    }
    this.readyState = closingState;
    this.socket?.end(maskedFrame(0x8, Buffer.alloc(0)));
  }

  terminate() {
    if (this.readyState === closedState) return;
    this.readyState = closingState;
    this.socket?.destroy();
  }

  private beginHandshake() {
    this.socket?.write([
      'GET / HTTP/1.1',
      'Host: localhost',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${this.handshakeKey}`,
      'Sec-WebSocket-Version: 13',
      '',
      ''
    ].join('\r\n'));
  }

  private handleData(data: Buffer) {
    if (this.readyState === connectingState) {
      this.handleHandshake(data);
      return;
    }
    if (this.readyState !== openState && this.readyState !== closingState) return;
    this.frameBuffer = Buffer.concat([this.frameBuffer, data]);
    this.drainFrames();
  }

  private handleHandshake(data: Buffer) {
    this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, data]);
    if (this.handshakeBuffer.byteLength > maximumHandshakeBytes) {
      this.fail(new Error('WebSocket handshake exceeded the configured limit.'));
      return;
    }
    const headerEnd = this.handshakeBuffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = this.handshakeBuffer.subarray(0, headerEnd).toString('latin1');
    const remaining = this.handshakeBuffer.subarray(headerEnd + 4);
    this.handshakeBuffer = Buffer.alloc(0);
    const lines = header.split('\r\n');
    if (!/^HTTP\/1\.[01] 101(?:\s|$)/.test(lines[0] ?? '')) {
      this.fail(new Error('WebSocket upgrade was rejected.'));
      return;
    }
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(':');
      if (separator <= 0) continue;
      headers.set(
        line.slice(0, separator).trim().toLowerCase(),
        line.slice(separator + 1).trim()
      );
    }
    const expectedAccept = createHash('sha1')
      .update(this.handshakeKey + websocketMagic)
      .digest('base64');
    if (headers.get('sec-websocket-accept') !== expectedAccept ||
      headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      this.fail(new Error('WebSocket upgrade returned invalid headers.'));
      return;
    }
    this.readyState = openState;
    this.emit('open');
    if (remaining.byteLength > 0) {
      this.frameBuffer = remaining;
      this.drainFrames();
    }
  }

  private drainFrames() {
    while (this.frameBuffer.byteLength >= 2) {
      const first = this.frameBuffer[0]!;
      const second = this.frameBuffer[1]!;
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;
      if ((first & 0x70) !== 0 || masked) {
        this.fail(new Error('WebSocket server returned an invalid frame.'));
        return;
      }
      if (payloadLength === 126) {
        if (this.frameBuffer.byteLength < 4) return;
        payloadLength = this.frameBuffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.frameBuffer.byteLength < 10) return;
        const extendedLength = this.frameBuffer.readBigUInt64BE(2);
        if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.fail(new Error('WebSocket frame is too large.'));
          return;
        }
        payloadLength = Number(extendedLength);
        offset = 10;
      }
      if (payloadLength > this.maximumMessageBytes ||
        this.frameBuffer.byteLength < offset + payloadLength) {
        if (payloadLength > this.maximumMessageBytes) {
          this.fail(new Error('WebSocket message exceeds the configured limit.'));
        }
        return;
      }
      const payload = this.frameBuffer.subarray(offset, offset + payloadLength);
      this.frameBuffer = this.frameBuffer.subarray(offset + payloadLength);
      if (!this.handleFrame(opcode, final, payload)) return;
    }
  }

  private handleFrame(opcode: number, final: boolean, payload: Buffer) {
    if (opcode >= 0x8) return this.handleControlFrame(opcode, final, payload);
    if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) {
      this.fail(new Error('WebSocket server returned an unsupported frame.'));
      return false;
    }
    if (opcode === 0x0) {
      if (this.fragmentedOpcode === undefined) {
        this.fail(new Error('WebSocket continuation frame is invalid.'));
        return false;
      }
    } else if (this.fragmentedOpcode !== undefined) {
      this.fail(new Error('WebSocket fragmented message is invalid.'));
      return false;
    } else {
      this.fragmentedOpcode = opcode;
    }
    this.fragmentedChunks.push(payload);
    this.fragmentedBytes += payload.byteLength;
    if (this.fragmentedBytes > this.maximumMessageBytes) {
      this.fail(new Error('WebSocket message exceeds the configured limit.'));
      return false;
    }
    if (!final) return true;
    const message = Buffer.concat(this.fragmentedChunks, this.fragmentedBytes);
    const messageOpcode = this.fragmentedOpcode;
    this.fragmentedChunks = [];
    this.fragmentedBytes = 0;
    this.fragmentedOpcode = undefined;
    this.emit('message', message, messageOpcode === 0x2);
    return true;
  }

  private handleControlFrame(opcode: number, final: boolean, payload: Buffer) {
    if (!final || payload.byteLength > 125) {
      this.fail(new Error('WebSocket control frame is invalid.'));
      return false;
    }
    if (opcode === 0x8) {
      if (this.readyState === openState) {
        this.readyState = closingState;
        this.socket?.end(maskedFrame(0x8, payload));
      } else {
        this.socket?.end();
      }
      return false;
    }
    if (opcode === 0x9) {
      this.socket?.write(maskedFrame(0xA, payload));
      return true;
    }
    if (opcode === 0xA) return true;
    this.fail(new Error('WebSocket control frame is unsupported.'));
    return false;
  }

  private fail(error: Error) {
    if (this.readyState === closedState) return;
    this.readyState = closingState;
    this.emit('error', error);
    this.socket?.destroy();
  }

  private finishClose() {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.readyState = closedState;
    this.emit('close');
  }
}

function maskedFrame(opcode: number, payload: Buffer) {
  const mask = randomBytes(4);
  const lengthBytes = payload.byteLength < 126 ? 0 : payload.byteLength <= 0xffff ? 2 : 8;
  const frame = Buffer.allocUnsafe(2 + lengthBytes + mask.byteLength + payload.byteLength);
  frame[0] = 0x80 | opcode;
  if (lengthBytes === 0) {
    frame[1] = 0x80 | payload.byteLength;
  } else if (lengthBytes === 2) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.byteLength, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }
  const maskOffset = 2 + lengthBytes;
  mask.copy(frame, maskOffset);
  const payloadOffset = maskOffset + mask.byteLength;
  for (let index = 0; index < payload.byteLength; index++) {
    frame[payloadOffset + index] = payload[index]! ^ mask[index % 4]!;
  }
  return frame;
}
