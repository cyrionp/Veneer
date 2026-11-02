// Messages exchanged between the browser and the Veneer server over /ws.

import { isAidName, type AidName, type ScreenSnapshot } from '@veneer/terminal';

export type ServerMessage =
  /** First message on every socket. Keep `resumeToken` to reattach after a reload. */
  | { type: 'hello'; sessionId: string; resumeToken: string; resumed: boolean }
  | { type: 'status'; state: 'connecting' | 'connected' | 'closed'; message?: string }
  /** `seq` increases with every screen sent for this session. */
  | { type: 'screen'; seq: number; screen: ScreenSnapshot }
  | { type: 'error'; message: string }
  /** Screen definitions changed; refetch /api/screens. */
  | { type: 'screens'; version: number };

export type ClientMessage =
  /** Must be the first message. Pass the last resumeToken to reattach to a live session. */
  | { type: 'hello'; resumeToken?: string }
  | { type: 'submit'; aid: AidName; fields?: Record<string, string>; cursor?: { row: number; col: number } }
  | { type: 'reset' }
  | { type: 'sysreq' }
  | { type: 'attn' }
  /** Ends the host session now instead of waiting for the resume grace period. */
  | { type: 'disconnect' };

/** WebSocket close codes used by the server. */
export const CloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
  IDLE_TIMEOUT: 4001,
  HOST_CLOSED: 4002,
  SESSION_LIMIT: 4003,
  REPLACED: 4004,
  ENDED_BY_ADMIN: 4005,
} as const;

const MAX_FIELDS = 512;
const MAX_FIELD_LENGTH = 3564; // 27 x 132

/** Parse and validate a client message. Throws with a client-safe message on bad input. */
export function parseClientMessage(raw: string): ClientMessage {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    throw new Error('Message is not valid JSON');
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) throw new Error('Message must be an object');
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case 'hello':
      if (m.resumeToken === undefined) return { type: 'hello' };
      if (typeof m.resumeToken !== 'string' || m.resumeToken.length > 128) {
        throw new Error('hello.resumeToken must be a string');
      }
      return { type: 'hello', resumeToken: m.resumeToken };
    case 'reset':
    case 'sysreq':
    case 'attn':
    case 'disconnect':
      return { type: m.type };
    case 'submit': {
      if (!isAidName(m.aid)) throw new Error('submit.aid is not a valid AID key');
      const out: ClientMessage = { type: 'submit', aid: m.aid };
      if (m.fields !== undefined) {
        if (typeof m.fields !== 'object' || m.fields === null || Array.isArray(m.fields)) {
          throw new Error('submit.fields must be an object');
        }
        const entries = Object.entries(m.fields);
        if (entries.length > MAX_FIELDS) throw new Error('submit.fields has too many entries');
        const fields: Record<string, string> = {};
        for (const [id, value] of entries) {
          if (!/^\d{1,3}:\d{1,3}$/.test(id)) throw new Error(`submit.fields key "${id.slice(0, 20)}" is not a field id`);
          if (typeof value !== 'string' || value.length > MAX_FIELD_LENGTH) {
            throw new Error(`submit.fields["${id}"] must be a string`);
          }
          fields[id] = value;
        }
        out.fields = fields;
      }
      if (m.cursor !== undefined) {
        const c = m.cursor as Record<string, unknown> | null;
        const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 132;
        if (typeof c !== 'object' || c === null || !ok(c.row) || !ok(c.col)) {
          throw new Error('submit.cursor must be {row, col} with 1-based integers');
        }
        out.cursor = { row: c.row as number, col: c.col as number };
      }
      return out;
    }
    default:
      throw new Error('Unknown message type');
  }
}
