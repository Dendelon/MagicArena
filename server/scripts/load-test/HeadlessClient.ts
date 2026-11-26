import WebSocket, { type RawData } from 'ws';
import {
  PROTOCOL_VERSION,
  createInputMessage,
  getCodec,
  parseServerMessage,
  toSeq,
  toTick,
} from '@magicarena/shared';
import type {
  Codec,
  CodecMode,
  EntityId,
  GameMessage,
  PlayerId,
  Tick,
} from '@magicarena/shared';

import { createScriptedPlayer, type ScriptedInputStep } from './scriptedInput.ts';
import { rawDataToUtf8 } from '../../src/network/rawData.ts';

export interface HeadlessClientOptions {
  readonly url: string;
  readonly roomId: string;
  readonly name: string;
  readonly seed: number;
  readonly clientIndex: number;
  readonly connectTimeoutMs?: number;
}

export interface HeadlessClientStats {
  readonly joined: boolean;
  readonly connected: boolean;
  readonly inputsSent: number;
  readonly snapshotsReceived: number;
  readonly disconnects: number;
  readonly decodeErrors: number;
  readonly clientErrors: number;
  readonly skippedBackpressureInputs: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_INPUT_HZ = 30;
const MAX_CLIENT_BUFFERED_BYTES = 64 * 1024;

const rawDataToArrayBuffer = (data: RawData): ArrayBuffer => {
  if (data instanceof ArrayBuffer) {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy.buffer;
  }

  const combined = Buffer.concat(data);
  const copy = new Uint8Array(combined.byteLength);
  copy.set(combined);
  return copy.buffer;
};

/**
 * Headless WebSocket game client driving real protocol join, scripted inputs, and snapshot decoding.
 */
export class HeadlessClient {
  readonly #url: string;
  readonly #roomId: string;
  readonly #name: string;
  readonly #connectTimeoutMs: number;
  readonly #scriptStep: ScriptedInputStep;

  #socket: WebSocket | null = null;
  #codec: Codec<GameMessage> = getCodec('binary');
  #codecMode: CodecMode = 'binary';
  #playerId: PlayerId | null = null;
  #entityId: EntityId | null = null;
  #latestTick: Tick = toTick(0);
  #seq = 0;
  #stepIndex = 0;

  #joined = false;
  #closedIntentionally = false;
  #sendTimer: ReturnType<typeof setInterval> | null = null;

  #inputsSent = 0;
  #snapshotsReceived = 0;
  #disconnects = 0;
  #decodeErrors = 0;
  #clientErrors = 0;
  #skippedBackpressureInputs = 0;

  constructor(options: HeadlessClientOptions) {
    this.#url = options.url;
    this.#roomId = options.roomId;
    this.#name = options.name;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#scriptStep = createScriptedPlayer(options.seed, options.clientIndex);
  }

  get playerId(): PlayerId | null {
    return this.#playerId;
  }

  get entityId(): EntityId | null {
    return this.#entityId;
  }

  getStats(): HeadlessClientStats {
    return {
      joined: this.#joined,
      connected: this.#socket?.readyState === WebSocket.OPEN,
      inputsSent: this.#inputsSent,
      snapshotsReceived: this.#snapshotsReceived,
      disconnects: this.#disconnects,
      decodeErrors: this.#decodeErrors,
      clientErrors: this.#clientErrors,
      skippedBackpressureInputs: this.#skippedBackpressureInputs,
    };
  }

  connect(): Promise<void> {
    if (this.#socket !== null) {
      return Promise.reject(new Error(`Client ${this.#name} already initialized`));
    }

    this.#closedIntentionally = false;
    this.#joined = false;

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.#url);
      socket.binaryType = 'arraybuffer';
      this.#socket = socket;

      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.close();
        reject(new Error(`Client ${this.#name} timed out joining room "${this.#roomId}"`));
      }, this.#connectTimeoutMs);

      const finishJoin = (err?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        if (err !== undefined) {
          this.close();
          reject(err);
          return;
        }
        resolve();
      };

      socket.on('open', () => {
        const joinPayload = JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'join',
          room: this.#roomId,
          name: this.#name,
        });
        socket.send(joinPayload, (err) => {
          if (err !== undefined && err !== null) {
            this.#clientErrors += 1;
            finishJoin(err);
          }
        });
      });

      socket.on('message', (data: RawData, isBinary: boolean) => {
        this.#handleMessage(data, isBinary, finishJoin);
      });

      socket.on('ping', (payload: Buffer) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.pong(payload);
        }
      });

      socket.on('error', (err: Error) => {
        this.#clientErrors += 1;
        if (!settled) {
          finishJoin(err);
        }
      });

      socket.on('close', () => {
        this.stopSending();
        if (!this.#closedIntentionally) {
          this.#disconnects += 1;
        }
        if (!settled) {
          finishJoin(new Error(`Client ${this.#name} socket closed before joining`));
        }
      });
    });
  }

  startSending(hz = DEFAULT_INPUT_HZ): void {
    if (this.#sendTimer !== null) {
      return;
    }

    const intervalMs = Math.max(10, Math.round(1000 / hz));
    this.#sendTimer = setInterval(() => {
      this.#sendOneInput();
    }, intervalMs);
  }

  stopSending(): void {
    if (this.#sendTimer !== null) {
      clearInterval(this.#sendTimer);
      this.#sendTimer = null;
    }
  }

  resetMeasurementCounters(): void {
    this.#inputsSent = 0;
    this.#snapshotsReceived = 0;
    this.#disconnects = 0;
    this.#decodeErrors = 0;
    this.#clientErrors = 0;
    this.#skippedBackpressureInputs = 0;
  }

  close(): void {
    this.#closedIntentionally = true;
    this.stopSending();

    const socket = this.#socket;
    if (socket === null) {
      return;
    }
    this.#socket = null;

    if (
      socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.OPEN
    ) {
      socket.close(1000, 'load test finished');
    } else if (socket.readyState === WebSocket.CLOSING) {
      socket.terminate();
    }
    socket.removeAllListeners();
  }

  #handleMessage(
    data: RawData,
    isBinary: boolean,
    onJoined?: (err?: Error) => void,
  ): void {
    if (isBinary) {
      try {
        const buffer = rawDataToArrayBuffer(data);
        const decoded = this.#codec.decode(buffer);
        if (decoded.type === 'snapshot') {
          this.#latestTick = decoded.tick;
          this.#snapshotsReceived += 1;
        }
      } catch {
        this.#decodeErrors += 1;
      }
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawDataToUtf8(data));
    } catch {
      this.#decodeErrors += 1;
      return;
    }

    const result = parseServerMessage(parsedJson);
    if (!result.success) {
      this.#decodeErrors += 1;
      return;
    }

    const message = result.data;
    switch (message.type) {
      case 'joined': {
        this.#joined = true;
        this.#playerId = message.player.id;
        this.#entityId = message.entityId;
        this.#codecMode = message.codec;
        this.#codec = getCodec(this.#codecMode);
        if (onJoined !== undefined) {
          onJoined();
        }
        break;
      }
      case 'snapshot': {
        this.#latestTick = message.tick;
        this.#snapshotsReceived += 1;
        break;
      }
      default:
        break;
    }
  }

  #sendOneInput(): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN || !this.#joined) {
      return;
    }

    if (socket.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
      this.#skippedBackpressureInputs += 1;
      return;
    }

    const controls = this.#scriptStep(this.#stepIndex);
    this.#stepIndex += 1;
    this.#seq += 1;

    const message = createInputMessage({
      seq: toSeq(this.#seq),
      tick: this.#latestTick,
      thrust: controls.thrust,
      turn: controls.turn,
      brake: controls.brake,
      fire: controls.fire,
      homingFire: controls.homingFire,
      ...(controls.fireSeq !== undefined ? { fireSeq: controls.fireSeq } : {}),
    });

    const wirePayload = this.#codec.encode(message);
    socket.send(wirePayload, (err) => {
      if (err !== undefined && err !== null) {
        this.#clientErrors += 1;
        return;
      }
      this.#inputsSent += 1;
    });
  }
}

