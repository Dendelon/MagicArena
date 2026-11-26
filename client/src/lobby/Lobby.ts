import { z } from 'zod';

import { RoomInfoSchema } from '@magicarena/shared/protocol';

import type { RoomInfo } from '@magicarena/shared';

import { fetchJson } from '../assets/loader.ts';
import { createTypedEvents } from '../events.ts';

const RoomsResponseSchema = z.object({
  rooms: z.array(RoomInfoSchema),
});

export interface LobbyEvents {
  roomsChanged: RoomInfo[];

  error: Error;

  joined: {
    name: string;
    room: RoomInfo;
  };
}

interface LobbyOptions {
  url?: string;
  refreshMs?: number;
  timeoutMs?: number;
}

export class Lobby {
  #events = createTypedEvents<LobbyEvents>();

  readonly addEventListener = this.#events.addEventListener;

  readonly removeEventListener = this.#events.removeEventListener;

  #timer: number | null = null;
  #controller: AbortController | null = null;
  #visible = false;
  #rooms: RoomInfo[] = [];

  readonly url: string;
  readonly refreshMs: number;
  readonly timeoutMs: number;

  constructor({
    url = '/api/rooms',
    refreshMs = 5000,
    timeoutMs = 3000,
  }: LobbyOptions = {}) {
    this.url = url;
    this.refreshMs = refreshMs;
    this.timeoutMs = timeoutMs;
  }

  get rooms(): RoomInfo[] {
    return [...this.#rooms];
  }

  open(): void {
    if (this.#visible) return;
    this.#visible = true;
    const triggerRefresh = (): void => {
      this.refresh().catch((error: unknown) => {
        if (!this.#visible) return;
        this.#events.emit(
          'error',
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    };
    triggerRefresh();
    this.#timer = window.setInterval(triggerRefresh, this.refreshMs);
  }

  close(): void {
    this.#visible = false;
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#controller?.abort();
    this.#controller = null;
  }

  async refresh(): Promise<void> {
    if (!this.#visible) return;
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.timeoutMs),
    ]);
    try {
      const raw = await fetchJson(this.url, { signal });
      if (!this.#visible || controller.signal.aborted) return;
      const data = RoomsResponseSchema.parse(raw);
      this.#rooms = data.rooms;
      this.#events.emit('roomsChanged', this.rooms);
    } catch (error: unknown) {
      if (!this.#visible || controller.signal.aborted) return;
      this.#events.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      if (this.#controller === controller) this.#controller = null;
    }
  }

  join(name: string, roomId: string): boolean {
    if (!this.#visible) return false;
    const trimmed = String(name).trim().slice(0, 24);
    const room = this.#rooms.find((item) => item.id === roomId);
    if (!trimmed || !room) return false;
    this.#events.emit('joined', { name: trimmed, room });
    this.close();
    return true;
  }
}

