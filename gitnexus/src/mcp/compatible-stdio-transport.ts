import process from 'node:process';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export type StdioFraming = 'content-length' | 'newline';

function deserializeMessage(raw: string): JSONRPCMessage {
  return JSONRPCMessageSchema.parse(JSON.parse(raw));
}

function serializeNewlineMessage(message: JSONRPCMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function serializeContentLengthMessage(message: JSONRPCMessage): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function findHeaderEnd(buffer: Buffer): { index: number; separatorLength: number } | null {
  const crlfEnd = buffer.indexOf('\r\n\r\n');
  if (crlfEnd !== -1) {
    return { index: crlfEnd, separatorLength: 4 };
  }

  const lfEnd = buffer.indexOf('\n\n');
  if (lfEnd !== -1) {
    return { index: lfEnd, separatorLength: 2 };
  }

  return null;
}

function looksLikeContentLength(buffer: Buffer): boolean {
  if (buffer.length < 14) {
    return false;
  }
  const probe = buffer.toString('utf8', 0, Math.min(buffer.length, 32));
  return /^content-length\s*:/i.test(probe);
}

const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB — generous for JSON-RPC

export class CompatibleStdioServerTransport implements Transport {
  private _readBuffer: Buffer | undefined;
  private _started = false;
  private _framing: StdioFraming | null = null;

  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(
    private readonly _stdin: NodeJS.ReadableStream = process.stdin,
    private readonly _stdout: NodeJS.WritableStream = process.stdout,
  ) {}

  private readonly _ondata = (chunk: Buffer) => {
    this._readBuffer = this._readBuffer ? Buffer.concat([this._readBuffer, chunk]) : chunk;
    if (this._readBuffer.length > MAX_BUFFER_SIZE) {
      this.onerror?.(new Error(`Read buffer exceeded maximum size (${MAX_BUFFER_SIZE} bytes)`));
      this.discardBufferedInput();
      return;
    }
    this.processReadBuffer();
  };

  private readonly _onerror = (error: Error) => {
    this.onerror?.(error);
  };

  async start() {
    if (this._started) {
      throw new Error('CompatibleStdioServerTransport already started!');
    }

    this._started = true;
    this._stdin.on('data', this._ondata);
    this._stdin.on('error', this._onerror);
  }

  private detectFraming(): StdioFraming | null {
    if (!this._readBuffer || this._readBuffer.length === 0) {
      return null;
    }

    const firstByte = this._readBuffer[0];
    if (firstByte === 0x7b || firstByte === 0x5b) {
      return 'newline';
    }

    if (looksLikeContentLength(this._readBuffer)) {
      return 'content-length';
    }

    return null;
  }

  private discardBufferedInput() {
    this._readBuffer = undefined;
    this._framing = null;
  }

  private readContentLengthMessage(): JSONRPCMessage | null {
    if (!this._readBuffer) {
      return null;
    }

    const header = findHeaderEnd(this._readBuffer);
    if (header === null) {
      return null;
    }

    const headerText = this._readBuffer
      .toString('utf8', 0, header.index)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    const match = headerText.match(/(?:^|\n)content-length\s*:\s*(\d+)/i);
    if (!match) {
      this.discardBufferedInput();
      throw new Error('Missing Content-Length header from MCP client');
    }

    const contentLength = Number.parseInt(match[1], 10);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      this.discardBufferedInput();
      throw new Error('Invalid Content-Length header from MCP client');
    }
    if (contentLength > MAX_BUFFER_SIZE) {
      this.discardBufferedInput();
      throw new Error(
        `Content-Length ${contentLength} exceeds maximum allowed size (${MAX_BUFFER_SIZE} bytes)`,
      );
    }
    const bodyStart = header.index + header.separatorLength;
    const bodyEnd = bodyStart + contentLength;
    if (this._readBuffer.length < bodyEnd) {
      return null;
    }

    const body = this._readBuffer.toString('utf8', bodyStart, bodyEnd);
    this._readBuffer = this._readBuffer.subarray(bodyEnd);
    return deserializeMessage(body);
  }

  private readNewlineMessage(): JSONRPCMessage | null {
    if (!this._readBuffer) {
      return null;
    }

    while (true) {
      const newlineIndex = this._readBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        return null;
      }

      const line = this._readBuffer.toString('utf8', 0, newlineIndex).replace(/\r$/, '');
      this._readBuffer = this._readBuffer.subarray(newlineIndex + 1);
      if (line.trim().length === 0) {
        continue;
      }

      return deserializeMessage(line);
    }
  }

  private readMessage(): JSONRPCMessage | null {
    if (!this._readBuffer || this._readBuffer.length === 0) {
      return null;
    }

    if (this._framing === null) {
      this._framing = this.detectFraming();
      if (this._framing === null) {
        return null;
      }
    }

    return this._framing === 'content-length'
      ? this.readContentLengthMessage()
      : this.readNewlineMessage();
  }

  private processReadBuffer() {
    while (true) {
      try {
        const message = this.readMessage();
        if (message === null) {
          break;
        }
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error as Error);
        break;
      }
    }
  }

  async close() {
    this._stdin.off('data', this._ondata);
    this._stdin.off('error', this._onerror);

    const remainingDataListeners = this._stdin.listenerCount('data');
    if (remainingDataListeners === 0) {
      this._stdin.pause();
    }

    this._started = false;
    this._readBuffer = undefined;
    this.onclose?.();
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions) {
    return new Promise<void>((resolve, reject) => {
      if (!this._started) {
        reject(new Error('Transport is closed'));
        return;
      }

      const payload =
        this._framing === 'newline'
          ? serializeNewlineMessage(message)
          : serializeContentLengthMessage(message);

      const onError = (error: Error) => {
        this._stdout.removeListener('error', onError);
        reject(error);
      };

      this._stdout.on('error', onError);

      if (this._stdout.write(payload)) {
        this._stdout.removeListener('error', onError);
        resolve();
      } else {
        this._stdout.once('drain', () => {
          this._stdout.removeListener('error', onError);
          resolve();
        });
      }
    });
  }
}
