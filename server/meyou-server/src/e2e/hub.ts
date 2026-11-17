// Live delivery of queue frames to open WebSockets (one set of sockets per device).
// Replay and live frames never overlap: every socket remembers the last seq it was sent.
import type { WebSocket } from 'ws';

export interface QueueFrame {
  seq: number;
  time: string;
  body: unknown;
}

interface Live {
  ws: WebSocket;
  lastSeq: number;
  alive: boolean;
  /** Hash of the token the socket was opened with (S11: a rotation from the CLI closes it). */
  tokenHash: string;
}

/** A device may keep a few sockets (reconnects overlap briefly); the oldest is replaced. */
const MAX_SOCKETS_PER_DEVICE = 4;

export class SocketHub {
  private readonly sockets = new Map<string, Set<Live>>();
  private timer: NodeJS.Timeout | null = null;
  /** Devices announced as online, and the pending "went offline" timers (grace period for quick reconnects). */
  private readonly announced = new Set<string>();
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();
  private presenceListener: ((deviceId: string, online: boolean) => void) | null = null;

  /**
   * `presenceGraceMs`: a device whose last socket closed is announced offline only after this long, so a reconnect
   * (network switch, the app restarting its listener) does not flicker the partner's "online" mark. 0 = at once.
   */
  constructor(
    private readonly pingEveryMs = 30_000,
    private readonly presenceGraceMs = 15_000,
  ) {}

  /** Called when a device goes online / offline (the queue tells the partner's sockets). One listener. */
  setPresenceListener(fn: ((deviceId: string, online: boolean) => void) | null): void {
    this.presenceListener = fn;
  }

  /** True while the device has an open socket (or just lost the last one, inside the grace period). */
  isOnline(deviceId: string): boolean {
    return this.announced.has(deviceId);
  }

  private markOnline(deviceId: string): void {
    const t = this.offlineTimers.get(deviceId);
    if (t) clearTimeout(t);
    this.offlineTimers.delete(deviceId);
    if (this.announced.has(deviceId)) return;
    this.announced.add(deviceId);
    this.presenceListener?.(deviceId, true);
  }

  /** Call after a device's socket set may have become empty. */
  private maybeOffline(deviceId: string, immediate = false): void {
    if (this.sockets.has(deviceId) || !this.announced.has(deviceId) || this.offlineTimers.has(deviceId)) return;
    const fire = () => {
      this.offlineTimers.delete(deviceId);
      if (this.sockets.has(deviceId) || !this.announced.delete(deviceId)) return;
      this.presenceListener?.(deviceId, false);
    };
    if (immediate || this.presenceGraceMs <= 0) {
      fire();
      return;
    }
    const t = setTimeout(fire, this.presenceGraceMs);
    t.unref();
    this.offlineTimers.set(deviceId, t);
  }

  /** Sends `{type:'presence', online}` to every open socket of a device. */
  sendPresence(toDevice: string, online: boolean): void {
    const set = this.sockets.get(toDevice);
    if (!set) return;
    const frame = JSON.stringify({ type: 'presence', online });
    for (const live of set) {
      if (live.ws.readyState !== 1) continue;
      try {
        live.ws.send(frame);
      } catch {
        /* removed by its close/error event */
      }
    }
  }

  start(): void {
    if (this.timer || this.pingEveryMs <= 0) return;
    this.timer = setInterval(() => this.heartbeat(), this.pingEveryMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    this.offlineTimers.clear();
  }

  /** Registers a socket that already received everything up to `lastSeq`. */
  add(deviceId: string, ws: WebSocket, lastSeq: number, tokenHash = ''): Live {
    const live: Live = { ws, lastSeq, alive: true, tokenHash };
    let set = this.sockets.get(deviceId);
    if (!set) this.sockets.set(deviceId, (set = new Set()));
    while (set.size >= MAX_SOCKETS_PER_DEVICE) {
      const oldest = set.values().next().value as Live;
      set.delete(oldest);
      this.closeQuietly(oldest.ws, 4000, 'replaced');
    }
    set.add(live);
    this.markOnline(deviceId);
    ws.on('pong', () => {
      live.alive = true;
    });
    ws.on('close', () => this.remove(deviceId, live));
    ws.on('error', () => this.remove(deviceId, live));
    return live;
  }

  private remove(deviceId: string, live: Live): void {
    const set = this.sockets.get(deviceId);
    if (!set) return;
    set.delete(live);
    if (set.size === 0) {
      this.sockets.delete(deviceId);
      this.maybeOffline(deviceId);
    }
  }

  /** Send a stored message to every open socket of the recipient that has not seen it yet. */
  deliver(toDevice: string, msg: QueueFrame): void {
    const set = this.sockets.get(toDevice);
    if (!set) return;
    const frame = JSON.stringify({ type: 'message', ...msg });
    for (const live of set) {
      if (msg.seq <= live.lastSeq || live.ws.readyState !== 1) continue;
      live.lastSeq = msg.seq;
      try {
        live.ws.send(frame);
      } catch {
        /* a broken socket is removed by its close/error event */
      }
    }
  }

  /** Revoked device: close all its sockets (code 4401 = token no longer valid). */
  closeDevice(deviceId: string, code = 4401, reason = 'revoked'): void {
    const set = this.sockets.get(deviceId);
    if (!set) return;
    this.sockets.delete(deviceId);
    for (const live of set) this.closeQuietly(live.ws, code, reason);
    this.maybeOffline(deviceId, true);
  }

  /**
   * S11: close sockets whose token is no longer the device's current one. Needed because the CLI
   * (`rotate-token`, `revoke`) is another process and cannot reach the sockets of the running server.
   * `currentHash` returns the device's valid token hash, or null when it is revoked or gone.
   */
  sweep(currentHash: (deviceId: string) => string | null): number {
    let closed = 0;
    for (const [id, set] of [...this.sockets]) {
      const now = currentHash(id);
      for (const live of [...set]) {
        if (now !== null && now === live.tokenHash) continue;
        set.delete(live);
        this.closeQuietly(live.ws, 4401, 'revoked');
        closed += 1;
      }
      if (set.size === 0) {
        this.sockets.delete(id);
        this.maybeOffline(id, true);
      }
    }
    return closed;
  }

  openCount(deviceId?: string): number {
    if (deviceId) return this.sockets.get(deviceId)?.size ?? 0;
    let n = 0;
    for (const set of this.sockets.values()) n += set.size;
    return n;
  }

  private heartbeat(): void {
    for (const [id, set] of this.sockets) {
      for (const live of [...set]) {
        if (!live.alive) {
          set.delete(live);
          try {
            live.ws.terminate();
          } catch {
            /* ignore */
          }
          continue;
        }
        live.alive = false;
        try {
          live.ws.ping();
        } catch {
          /* ignore */
        }
      }
      if (set.size === 0) {
        this.sockets.delete(id);
        this.maybeOffline(id);
      }
    }
  }

  private closeQuietly(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
  }
}
