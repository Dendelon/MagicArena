import { fetchJson } from '../assets/loader.js';

export class Lobby extends EventTarget {
  #timer = null;
  #controller = null;
  #visible = false;
  #rooms = [];

  constructor({ url = '/api/rooms', refreshMs = 5000, timeoutMs = 3000 } = {}) {
    super();
    this.url = url;
    this.refreshMs = refreshMs;
    this.timeoutMs = timeoutMs;
  }

  get rooms() {
    return [...this.#rooms];
  }

  open() {
    if (this.#visible) return;
    this.#visible = true;
    void this.refresh();
    this.#timer = window.setInterval(() => void this.refresh(), this.refreshMs);
  }

  close() {
    this.#visible = false;
    window.clearInterval(this.#timer);
    this.#timer = null;
    this.#controller?.abort();
    this.#controller = null;
  }

  async refresh() {
    if (!this.#visible) return;
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.timeoutMs),
    ]);
    try {
      const data = await fetchJson(this.url, { signal });
      if (!this.#visible || controller.signal.aborted) return;
      if (!Array.isArray(data.rooms)) throw new Error('Invalid rooms response');
      this.#rooms = data.rooms;
      this.dispatchEvent(new CustomEvent('roomsChanged', { detail: this.rooms }));
    } catch (error) {
      if (!this.#visible || controller.signal.aborted) return;
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    } finally {
      if (this.#controller === controller) this.#controller = null;
    }
  }

  join(name, roomId) {
    if (!this.#visible) return false;
    const trimmed = String(name).trim().slice(0, 24);
    const room = this.#rooms.find((item) => item.id === roomId);
    if (!trimmed || !room) return false;
    this.dispatchEvent(new CustomEvent('joined', { detail: { name: trimmed, room } }));
    this.close();
    return true;
  }
}
