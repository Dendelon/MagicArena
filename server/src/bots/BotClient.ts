import WebSocket from 'ws';
import type { RawData } from 'ws';

import {
  PROTOCOL_VERSION,
  createInputMessage,
  getCodec,
  parseServerMessage,
} from '@magicarena/shared';

import type {
  Bounds,
  CodecMode,
  PlayerId,
  SnapshotMessage,
  Tick,
} from '@magicarena/shared';

import { Bot } from './Bot.ts';

const INPUT_INTERVAL_MS = 1000 / 30;
const INPUT_STEP_SEC = 1 / 30;
const MAX_BOT_BUFFERED_AMOUNT = 64 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

export interface BotClientOptions {
  url: string;
  roomId: string;
  name: string;
  seed: number;
  connectTimeoutMs?: number;
}

const rawToBuffer = (data: RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);

  return Buffer.from(data);
};

export class BotClient {
  readonly name: string;
  readonly roomId: string;

  readonly #url: string;
  readonly #connectTimeoutMs: number;
  readonly #bot: Bot;

  #socket: WebSocket | null = null;
  #playerId: PlayerId | null = null;
  #codec: CodecMode | null = null;
  #bounds: Bounds = { width: 960, height: 640 };

  #latestSnapshot: SnapshotMessage | null = null;
  #lastSnapshotTick: Tick | null = null;

  #inputTimer: ReturnType<typeof setInterval> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  #disconnectPromise: Promise<void> | null = null;

  #nextSeq = 1;
  #simTimeSec = 0;
  #stopped = false;

  constructor({
    url,
    roomId,
    name,
    seed,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  }: BotClientOptions) {
    this.#url = url;
    this.roomId = roomId;
    this.name = name;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#bot = new Bot(seed);
  }

  get playerId(): PlayerId | null {
    return this.#playerId;
  }

  get isConnected(): boolean {
    return (
      !this.#stopped &&
      this.#socket !== null &&
      this.#socket.readyState === WebSocket.OPEN &&
      this.#playerId !== null
    );
  }

  async connect(): Promise<PlayerId> {
    if (this.#stopped) {
      throw new Error(`Bot ${this.name} is already stopped`);
    }

    if (this.#socket !== null) {
      throw new Error(`Bot ${this.name} is already connecting or connected`);
    }

    const socket = new WebSocket(this.#url);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;

    return new Promise<PlayerId>((resolve, reject) => {
      let settled = false;

      const clearConnectTimer = (): void => {
        if (this.#connectTimer !== null) {
          clearTimeout(this.#connectTimer);
          this.#connectTimer = null;
        }
      };

      const failJoin = (reason: Error): void => {
        if (settled) return;
        settled = true;
        clearConnectTimer();
        this.stop();
        reject(reason);
      };

      this.#connectTimer = setTimeout(() => {
        failJoin(new Error(`Bot ${this.name} timed out waiting to join`));
      }, this.#connectTimeoutMs);

      const onOpen = (): void => {
        if (this.#stopped || this.#socket !== socket) return;

        socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'join',
            room: this.roomId,
            name: this.name,
          }),
        );
      };

      const onMessage = (data: RawData, isBinary: boolean): void => {
        if (this.#stopped || this.#socket !== socket) return;

        try {
          const decoded: unknown = isBinary
            ? getCodec('binary').decode(rawToBuffer(data))
            : JSON.parse(rawToBuffer(data).toString('utf8'));

          const parsed = parseServerMessage(decoded);

          if (!parsed.success) {
            if (!settled) {
              failJoin(new Error(`Invalid server message for bot ${this.name}`));
            }
            return;
          }

          const message = parsed.data;

          if (message.type === 'joined') {
            this.#playerId = message.player.id;
            this.#codec = message.codec;

            if (message.bounds) {
              this.#bounds = {
                width: message.bounds.width,
                height: message.bounds.height,
              };
            }

            if (!settled) {
              settled = true;
              clearConnectTimer();
              this.#startInputLoop();
              resolve(message.player.id);
            }
            return;
          }

          if (message.type === 'snapshot') {
            if (
              this.#lastSnapshotTick !== null &&
              message.tick <= this.#lastSnapshotTick
            ) {
              return;
            }

            this.#lastSnapshotTick = message.tick;
            this.#latestSnapshot = message;
          }
        } catch (error: unknown) {
          if (!settled) {
            failJoin(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
      };

      const onClose = (code: number, reason: Buffer): void => {
        if (!settled) {
          failJoin(
            new Error(
              `Bot ${this.name} disconnected before joining (${code}: ${reason.toString('utf8')})`,
            ),
          );
          return;
        }

        this.stop();
      };

      const onError = (error: Error): void => {
        if (!settled) {
          failJoin(error);
          return;
        }

        this.stop();
      };

      socket.once('open', onOpen);
      socket.on('message', onMessage);
      socket.once('close', onClose);
      socket.once('error', onError);
    });
  }

  #startInputLoop(): void {
    if (this.#stopped || this.#inputTimer !== null) return;

    this.#inputTimer = setInterval(() => {
      this.#sendTickInput();
    }, INPUT_INTERVAL_MS);
  }

  #sendTickInput(): void {
    if (
      this.#stopped ||
      !this.#socket ||
      this.#socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    if (!this.#playerId || !this.#codec || !this.#latestSnapshot) {
      return;
    }

    if (this.#socket.bufferedAmount > MAX_BOT_BUFFERED_AMOUNT) {
      return;
    }

    const controls = this.#bot.decide(
      this.#latestSnapshot,
      this.#playerId,
      this.#simTimeSec,
      this.#bounds,
    );

    this.#simTimeSec += INPUT_STEP_SEC;

    const seq = this.#nextSeq++;

    const input = createInputMessage({
      seq,
      tick: this.#latestSnapshot.tick,
      thrust: controls.thrust,
      turn: controls.turn,
      brake: controls.brake,
      fire: controls.fire,
      homingFire: controls.homingFire,
      fireSeq: controls.fire || controls.homingFire ? seq : undefined,
    });

    const payload = getCodec(this.#codec).encode(input);

    this.#socket.send(payload);
  }

  #clearTimers(): void {
    if (this.#connectTimer !== null) {
      clearTimeout(this.#connectTimer);
      this.#connectTimer = null;
    }

    if (this.#inputTimer !== null) {
      clearInterval(this.#inputTimer);
      this.#inputTimer = null;
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimers();

    const socket = this.#socket;
    this.#socket = null;

    if (!socket) return;

    socket.removeAllListeners();
    // Keep error listener after removeAllListeners so abrupt disconnects never throw unhandled 'error'.
    socket.on('error', () => {});

    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      try {
        socket.close(1000, 'Bot stopped');
      } catch {
        socket.terminate();
      }
    }
  }

  disconnect(): Promise<void> {
    this.#stopped = true;
    this.#clearTimers();

    if (this.#disconnectPromise !== null) {
      return this.#disconnectPromise;
    }

    const socket = this.#socket;
    this.#socket = null;

    if (!socket || socket.readyState === WebSocket.CLOSED) {
      this.#disconnectPromise = Promise.resolve();
      return this.#disconnectPromise;
    }

    this.#disconnectPromise = new Promise<void>((resolve) => {
      let finished = false;

      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.off('close', onClose);
        resolve();
      };

      const onClose = (): void => {
        finish();
      };

      const timer = setTimeout(() => {
        try {
          socket.terminate();
        } finally {
          finish();
        }
      }, 500);

      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.once('close', onClose);

      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        try {
          socket.close(1000, 'Bot disconnected');
        } catch {
          socket.terminate();
        }
      } else if (socket.readyState !== WebSocket.CLOSING) {
        finish();
      }
    });

    return this.#disconnectPromise;
  }
}

