// Live delivery of mailbox messages to open WebSockets (one set of sockets per device).
// Replay and live frames never overlap: every socket remembers the last seq it was sent.
import type { WebSocket } from 'ws';

export interface MailboxMessage {
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

export class MailboxHub {
  private readonly sockets = new Map<string, Set<Live>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly pingEveryMs = 30_000) {}

  start(): void {
    if (this.timer || this.pingEveryMs <= 0) return;
    this.timer = setInterval(() => this.heartbeat(), this.pingEveryMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
    if (set.size === 0) this.sockets.delete(deviceId);
  }

  /** Send a stored message to every open socket of the recipient that has not seen it yet. */
  deliver(toDevice: string, msg: MailboxMessage): void {
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
      if (set.size === 0) this.sockets.delete(id);
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
      if (set.size === 0) this.sockets.delete(id);
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
