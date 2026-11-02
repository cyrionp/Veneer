// Browser sessions: each WebSocket owns one host session. A socket
// that drops (e.g. a page reload) leaves the host session running for a grace
// period, during which a new socket can reattach with the resume token.

import { randomBytes, randomUUID } from 'node:crypto';
import { DeviceNameInUseError, type ScreenSnapshot, type TerminalSession } from '@veneer/terminal';
import { Session, type HostSettings } from '@veneer/tn5250';
import WebSocket from 'ws';
import { DeviceNamePool } from './devices.ts';
import type { ScreenInventory } from './inventory.ts';
import { log } from './log.ts';
import { CloseCode, parseClientMessage, type ClientMessage, type ServerMessage } from './protocol.ts';
import { displayName, signOnUserField, submittedUser } from './signon.ts';

export interface SessionManagerOptions {
  host: HostSettings;
  idleTimeoutMs: number;
  resumeGraceMs: number;
  maxSessions: number;
  /** Name devices PREFIX01, PREFIX02, ...; unset lets IBM i assign names. */
  deviceNamePrefix?: string | undefined;
  /** Log every 5250 record; see traceRecord. */
  trace?: boolean;
  /** How long a new socket has to send its hello message. */
  helloTimeoutMs?: number;
  /** Records each screen sessions show. */
  inventory?: ScreenInventory | undefined;
}

/** What the admin page shows about a session. */
export interface SessionInfo {
  id: string;
  /** IBM i user, once signed on. */
  user: string | null;
  device: string | null;
  remote: string;
  connectedAt: string;
  lastActivity: string;
  hostConnected: boolean;
  /** A browser is attached; otherwise the session waits for a reload until `graceEndsAt`. */
  attached: boolean;
  graceEndsAt: string | null;
}

/** Other device names to try when the host says one is in use. */
const DEVICE_NAME_RETRIES = 3;

/** Host records often arrive in quick bursts; coalesce them into one screen push. */
const PUSH_DELAY_MS = 10;

export class BrowserSession {
  readonly id = randomUUID();
  readonly resumeToken = randomBytes(32).toString('base64url');
  readonly host: TerminalSession;
  /** Requested device name; changes when the host says a name is in use. */
  deviceName: string | undefined;
  readonly remote: string;
  readonly createdAt = Date.now();
  /** Display name read from the sign-on screen when IBM i assigned it. */
  shownDevice: string | undefined;
  /** User signed on, and the one submitted on the sign-on screen until the host accepts it. */
  user: string | undefined;
  pendingUser: string | undefined;
  socket: WebSocket | null = null;
  lastActivity = Date.now();
  graceEndsAt: number | undefined;
  seq = 0;
  closed = false;
  graceTimer: NodeJS.Timeout | undefined;
  pushTimer: NodeJS.Timeout | undefined;

  constructor(host: TerminalSession, deviceName: string | undefined, remote: string) {
    this.host = host;
    this.deviceName = deviceName;
    this.remote = remote;
  }

  send(msg: ServerMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }
}

export class SessionManager {
  private readonly opts: SessionManagerOptions;
  private readonly sessions = new Map<string, BrowserSession>(); // by resume token
  private readonly idleSweep: NodeJS.Timeout;
  private readonly devices: DeviceNamePool | undefined;

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
    this.devices = opts.deviceNamePrefix ? new DeviceNamePool(opts.deviceNamePrefix) : undefined;
    this.idleSweep = setInterval(() => this.sweepIdle(), Math.min(30_000, Math.max(1000, opts.idleTimeoutMs / 4)));
    this.idleSweep.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Take ownership of a new socket. Its first message must be a hello. */
  accept(socket: WebSocket, remote: string): void {
    const timer = setTimeout(() => socket.close(CloseCode.POLICY_VIOLATION, 'No hello received'), this.opts.helloTimeoutMs ?? 5000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      let msg: ClientMessage;
      try {
        msg = parseClientMessage(data.toString());
      } catch (err) {
        return rejectSocket(socket, (err as Error).message);
      }
      if (msg.type !== 'hello') return rejectSocket(socket, 'First message must be hello');
      const existing = msg.resumeToken ? this.sessions.get(msg.resumeToken) : undefined;
      if (existing && !existing.closed) this.attach(existing, socket, true, remote);
      else this.create(socket, remote);
    });
  }

  private create(socket: WebSocket, remote: string): void {
    if (this.sessions.size >= this.opts.maxSessions) {
      log.warn('session limit reached', { remote, max: this.opts.maxSessions });
      socket.send(JSON.stringify({ type: 'error', message: 'Too many sessions; try again later' } satisfies ServerMessage));
      socket.close(CloseCode.SESSION_LIMIT, 'Session limit reached');
      return;
    }
    const deviceName = this.devices?.acquire();
    if (this.devices && !deviceName) {
      log.warn('no free device names', { prefix: this.devices.prefix, capacity: this.devices.capacity });
      socket.send(JSON.stringify({ type: 'error', message: 'Too many sessions; try again later' } satisfies ServerMessage));
      socket.close(CloseCode.SESSION_LIMIT, 'No free device names');
      return;
    }
    let retries = 0;
    const host: TerminalSession = new Session({
      ...this.opts.host,
      ...(this.opts.trace ? { trace: (dir: 'in' | 'out', rec: Buffer) => traceRecord(bs, dir, rec) } : {}),
      ...(deviceName ? { deviceName, onDeviceNameInUse: (name: string) => this.nextDeviceName(bs, name, ++retries) } : {}),
    });
    const bs: BrowserSession = new BrowserSession(host, deviceName, remote);
    this.sessions.set(bs.resumeToken, bs);
    log.info('session created', { session: bs.id, remote, ...(deviceName ? { device: deviceName } : {}) });

    host.once('screen', (screen) => {
      log.info('device assigned', { session: bs.id, device: bs.deviceName ?? displayName(screen) ?? 'unknown' });
    });
    host.on('screen', () => this.schedulePush(bs));
    host.on('warning', (message) => log.warn('protocol warning', { session: bs.id, message }));
    host.on('close', (err) => {
      if (err instanceof DeviceNameInUseError) {
        bs.send({ type: 'error', message: 'All device names tried are in use on the IBM i; try again later' });
        return this.destroy(bs, CloseCode.HOST_CLOSED, 'No free device name');
      }
      if (err) log.warn('host connection error', { session: bs.id, error: err.message });
      this.destroy(bs, CloseCode.HOST_CLOSED, 'Host closed the connection');
    });

    this.attach(bs, socket, false, remote);
    bs.send({ type: 'status', state: 'connecting' });
    host.connect().then(
      () => {
        log.info('host connected', { session: bs.id });
        bs.send({ type: 'status', state: 'connected' });
      },
      (err: Error) => {
        log.warn('host connect failed', { session: bs.id, error: err.message });
        bs.send({ type: 'error', message: `Could not connect to the IBM i: ${err.message}` });
        this.destroy(bs, CloseCode.HOST_CLOSED, 'Host connection failed');
      },
    );
  }

  /**
   * The host says `name` is in use, e.g. by a job left over from before a
   * restart or another emulator. Skip it for a while and offer the next one.
   */
  private nextDeviceName(bs: BrowserSession, name: string, attempt: number): string | undefined {
    this.devices!.avoid(name);
    const next = attempt <= DEVICE_NAME_RETRIES ? this.devices!.acquire() : undefined;
    log.warn('device name in use', { session: bs.id, device: name, ...(next ? { trying: next } : { giving_up: true }) });
    bs.deviceName = next;
    return next;
  }

  private attach(bs: BrowserSession, socket: WebSocket, resumed: boolean, remote: string): void {
    clearTimeout(bs.graceTimer);
    bs.graceTimer = undefined;
    bs.graceEndsAt = undefined;
    if (bs.socket && bs.socket !== socket) bs.socket.close(CloseCode.REPLACED, 'Session opened elsewhere');
    bs.socket = socket;
    bs.lastActivity = Date.now();
    if (resumed) log.info('session resumed', { session: bs.id, remote });

    socket.on('message', (data) => this.onMessage(bs, socket, data.toString()));
    socket.on('close', () => this.onSocketClose(bs, socket));

    bs.send({ type: 'hello', sessionId: bs.id, resumeToken: bs.resumeToken, resumed });
    if (resumed) {
      bs.send({ type: 'status', state: bs.host.connected ? 'connected' : 'connecting' });
      this.push(bs);
    }
  }

  private onMessage(bs: BrowserSession, socket: WebSocket, raw: string): void {
    if (bs.socket !== socket || bs.closed) return;
    bs.lastActivity = Date.now();
    let msg: ClientMessage;
    try {
      msg = parseClientMessage(raw);
    } catch (err) {
      bs.send({ type: 'error', message: (err as Error).message });
      return;
    }
    try {
      switch (msg.type) {
        case 'hello':
          throw new Error('Already said hello');
        case 'submit':
          bs.pendingUser = submittedUser(bs.host.snapshot(), msg.fields);
          bs.host.submit({
            aid: msg.aid,
            ...(msg.fields ? { fields: msg.fields } : {}),
            ...(msg.cursor ? { cursor: msg.cursor } : {}),
          });
          break;
        case 'reset':
          bs.host.reset();
          break;
        case 'sysreq':
          bs.host.systemRequest();
          break;
        case 'attn':
          bs.host.attention();
          break;
        case 'disconnect':
          log.info('session ended by client', { session: bs.id });
          this.destroy(bs, CloseCode.NORMAL, 'Disconnected');
          break;
      }
    } catch (err) {
      bs.send({ type: 'error', message: (err as Error).message });
    }
  }

  private onSocketClose(bs: BrowserSession, socket: WebSocket): void {
    if (bs.socket !== socket || bs.closed) return;
    bs.socket = null;
    if (this.opts.resumeGraceMs <= 0) return this.destroy(bs, CloseCode.GOING_AWAY, 'Socket closed');
    log.info('socket detached', { session: bs.id, graceMs: this.opts.resumeGraceMs });
    bs.graceEndsAt = Date.now() + this.opts.resumeGraceMs;
    bs.graceTimer = setTimeout(() => this.destroy(bs, CloseCode.GOING_AWAY, 'Resume grace period expired'), this.opts.resumeGraceMs);
  }

  private schedulePush(bs: BrowserSession): void {
    if (bs.pushTimer) return;
    bs.pushTimer = setTimeout(() => {
      bs.pushTimer = undefined;
      this.push(bs);
    }, PUSH_DELAY_MS);
  }

  private push(bs: BrowserSession): void {
    if (bs.closed || !bs.socket) return;
    const screen = bs.host.snapshot();
    // A locked screen is the host still working; count the one the user gets.
    if (!screen.keyboardLocked) {
      this.opts.inventory?.record(bs.id, screen);
      this.trackSignOn(bs, screen);
    }
    bs.send({ type: 'screen', seq: ++bs.seq, screen });
  }

  /** Leaving the sign-on screen means the submitted user signed on; returning to it, signed off. */
  private trackSignOn(bs: BrowserSession, screen: ScreenSnapshot): void {
    if (signOnUserField(screen)) {
      bs.shownDevice ??= displayName(screen);
      if (bs.user) log.info('signed off', { session: bs.id, user: bs.user });
      bs.user = undefined;
    } else if (bs.pendingUser) {
      bs.user = bs.pendingUser;
      log.info('signed on', { session: bs.id, user: bs.user });
    }
    bs.pendingUser = undefined;
  }

  private sweepIdle(): void {
    if (this.opts.idleTimeoutMs <= 0) return;
    const cutoff = Date.now() - this.opts.idleTimeoutMs;
    for (const bs of this.sessions.values()) {
      if (bs.lastActivity < cutoff) {
        log.info('session idle timeout', { session: bs.id });
        bs.send({ type: 'error', message: 'Session ended after a period of inactivity' });
        this.destroy(bs, CloseCode.IDLE_TIMEOUT, 'Idle timeout');
      }
    }
  }

  private destroy(bs: BrowserSession, code: number, reason: string): void {
    if (bs.closed) return;
    bs.closed = true;
    clearTimeout(bs.graceTimer);
    clearTimeout(bs.pushTimer);
    this.sessions.delete(bs.resumeToken);
    bs.send({ type: 'status', state: 'closed', message: reason });
    bs.socket?.close(code, reason);
    bs.socket = null;
    bs.host.close();
    if (bs.deviceName) this.devices?.release(bs.deviceName);
    this.opts.inventory?.forget(bs.id);
    log.info('session closed', { session: bs.id, reason });
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((bs) => ({
      id: bs.id,
      user: bs.user ?? null,
      device: bs.deviceName ?? bs.shownDevice ?? null,
      remote: bs.remote,
      connectedAt: new Date(bs.createdAt).toISOString(),
      lastActivity: new Date(bs.lastActivity).toISOString(),
      hostConnected: bs.host.connected,
      attached: bs.socket !== null,
      graceEndsAt: bs.graceEndsAt ? new Date(bs.graceEndsAt).toISOString() : null,
    }));
  }

  /** End a session from the admin page. Returns false if there is no such session. */
  end(id: string, by: string): boolean {
    const bs = [...this.sessions.values()].find((s) => s.id === id);
    if (!bs) return false;
    log.info('session ended by admin', { session: bs.id, by, ...(bs.user ? { user: bs.user } : {}) });
    bs.send({ type: 'error', message: 'Your session was ended by an administrator' });
    this.destroy(bs, CloseCode.ENDED_BY_ADMIN, 'Ended by an administrator');
    return true;
  }

  /** Send a message to every attached browser. */
  broadcast(msg: ServerMessage): void {
    for (const bs of this.sessions.values()) bs.send(msg);
  }

  /** End every session, e.g. on server shutdown, so the IBM i releases the devices. */
  closeAll(reason = 'Server shutting down'): void {
    clearInterval(this.idleSweep);
    for (const bs of [...this.sessions.values()]) this.destroy(bs, CloseCode.GOING_AWAY, reason);
  }
}

function rejectSocket(socket: WebSocket, message: string): void {
  socket.send(JSON.stringify({ type: 'error', message } satisfies ServerMessage));
  socket.close(CloseCode.POLICY_VIOLATION, 'Bad hello');
}

/**
 * Log a 5250 record in hex. What the browser sends (field values, a password
 * among them, and the screen in Save Screen replies) stays out: an outbound
 * record shows only its header and, for an AID, the cursor and AID byte.
 */
export function traceRecord(bs: { id: string }, dir: 'in' | 'out', rec: Buffer): void {
  const header = 6 + (rec[6] ?? 4);
  const shown = dir === 'in' ? rec : rec.subarray(0, Math.min(rec.length, header + 3));
  log.info('record', {
    session: bs.id, dir, length: rec.length, hex: shown.toString('hex'),
    ...(shown.length < rec.length ? { hidden: rec.length - shown.length } : {}),
  });
}
