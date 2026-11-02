import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { DeviceNameInUseError } from '@veneer/terminal';
import { Session, type SessionOptions } from '../src/session.ts';
import { e, parseReadModified, stream } from './helpers.ts';

const IAC = 0xff, DO = 0xfd, WILL = 0xfb, SB = 0xfa, SE = 0xf0, EOR = 0xef;
const TTYPE = 0x18, TN3270E = 0x28;

interface HostOptions {
  /** Speak plain TN3270 only. */
  plain?: boolean;
  /** LU names to report as in use. */
  busy?: string[];
}

/** A fake TN3270(E) host: negotiates, then hands each record to the test. */
async function fakeHost(opts: HostOptions = {}) {
  const records: number[][] = [];
  const raw: number[][] = [];
  const terminalTypes: string[] = [];
  const lus: string[] = [];
  let socket: net.Socket | undefined;
  let extended = false;
  let wake: (() => void) | undefined;
  let done!: () => void;
  const negotiated = new Promise<void>((r) => { done = r; });
  const server = net.createServer((s) => {
    socket = s;
    let record: number[] = [];
    let state: 'data' | 'iac' | 'sb' | 'sbiac' | 'verb' = 'data';
    let sub: number[] = [];
    const onSub = (data: number[]) => {
      const [option, ...rest] = data;
      if (option === TTYPE) {
        terminalTypes.push(String.fromCharCode(...rest.slice(1)));
        s.write(Buffer.from([IAC, DO, 0x19, IAC, WILL, 0x19, IAC, DO, 0x00, IAC, WILL, 0x00]));
        done();
      } else if (option === TN3270E && rest[0] === 0x02 && rest[1] === 0x07) {
        const connect = rest.indexOf(0x01);
        const type = String.fromCharCode(...rest.slice(2, connect < 0 ? undefined : connect));
        const lu = connect < 0 ? 'LU000042' : String.fromCharCode(...rest.slice(connect + 1));
        terminalTypes.push(type);
        lus.push(lu);
        if (opts.busy?.includes(lu)) s.write(Buffer.from([IAC, SB, TN3270E, 0x02, 0x06, 0x05, 0x01, IAC, SE]));
        else s.write(Buffer.from([IAC, SB, TN3270E, 0x02, 0x04, ...Buffer.from(type), 0x01, ...Buffer.from(lu), IAC, SE]));
      } else if (option === TN3270E && rest[0] === 0x03 && rest[1] === 0x07) {
        s.write(Buffer.from([IAC, SB, TN3270E, 0x03, 0x04, ...rest.slice(2), IAC, SE]));
        extended = true;
        done();
      }
    };
    s.on('data', (chunk) => {
      for (const b of chunk) {
        if (state === 'data') { if (b === IAC) state = 'iac'; else record.push(b); }
        else if (state === 'iac') {
          state = 'data';
          if (b === IAC) record.push(b);
          else if (b === EOR) {
            raw.push(record);
            records.push(extended ? record.slice(5) : record);
            record = [];
            wake?.();
          } else if (b === SB) { sub = []; state = 'sb'; }
          else if (b === WILL && !opts.plain) state = 'verb';
          else if (b === 0xf4) { raw.push([IAC, 0xf4]); wake?.(); }
          else state = b >= 0xfb ? 'verb' : 'data';
        } else if (state === 'verb') {
          state = 'data';
          if (b === TN3270E) s.write(Buffer.from([IAC, SB, TN3270E, 0x08, 0x02, IAC, SE]));
        } else if (state === 'sb') { if (b === IAC) state = 'sbiac'; else sub.push(b); }
        else { if (b === SE) { state = 'data'; onSub(sub); } else { sub.push(b); state = 'sb'; } }
      }
    });
    s.write(Buffer.from(opts.plain ? [IAC, DO, TTYPE, IAC, SB, TTYPE, 0x01, IAC, SE] : [IAC, DO, TN3270E]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, records, raw, terminalTypes, lus,
    /** Resolves when the client has finished negotiating. */
    negotiated,
    /** Send a 3270 data stream (with a TN3270E header when negotiated). */
    send: (data: number[]) => {
      const rec = extended ? [0x00, 0x00, 0x00, 0x00, 0x01, ...data] : data;
      socket!.write(Buffer.from([...rec.flatMap((b) => (b === IAC ? [b, b] : [b])), IAC, EOR]));
    },
    /** Wait until the client has sent n records. */
    received: async (n: number) => {
      while (raw.length < n) await new Promise<void>((r) => { wake = r; });
    },
    close: () => { socket?.destroy(); server.close(); },
  };
}

const signOnScreen = () => stream().eraseWrite()
  .text(1, 30, 'Sign On', { attr: 0x28 })
  .text(5, 10, 'User').input(5, 30, 8)
  .text(6, 10, 'Password').input(6, 30, 8, { attr: 0x0c })
  .cursor(5, 30).build();

/** Wait (up to a second) for something the client does after the host's last message. */
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

async function connected(host: Awaited<ReturnType<typeof fakeHost>>, opts: Partial<SessionOptions> = {}, plain = false) {
  const session = new Session({ host: '127.0.0.1', port: host.port, ...opts });
  await session.connect();
  await host.negotiated;
  // The host has sent its last negotiation message; let the client read it.
  if (!plain) await until(() => session.tn3270e);
  return session;
}

test('a TN3270E session: screens in, keys and fields out', async () => {
  const host = await fakeHost();
  const traced: string[] = [];
  const session = await connected(host, { trace: (dir) => traced.push(dir) });
  try {
    assert.equal(session.tn3270e, true);
    assert.equal(session.deviceName, 'LU000042', 'the LU the host picked');
    assert.deepEqual(host.terminalTypes, ['IBM-3278-2-E']);
    host.send(signOnScreen());
    let snap = await session.waitForInput();
    assert.equal(snap.host, '3270');
    assert.deepEqual(snap.fields.filter((f) => !f.bypass).map((f) => f.id), ['5:30', '6:30']);

    session.submit({ aid: 'Enter', fields: { '5:30': 'IBMUSER', '6:30': 'secret' }, cursor: { row: 6, col: 36 } });
    assert.equal(session.snapshot().keyboardLocked, true);
    assert.throws(() => session.submit({ aid: 'Enter' }), /Keyboard is locked/);
    await host.received(1);
    assert.deepEqual(host.raw[0]!.slice(0, 3), [0x00, 0x00, 0x00], 'a 3270-DATA header');
    assert.deepEqual(parseReadModified(host.records[0]!), {
      aid: 0x7d, cursor: { row: 6, col: 36 }, fields: { '5:30': 'IBMUSER', '6:30': 'secret' },
    });

    host.send(stream().eraseWrite().text(1, 2, 'Main menu').input(20, 7, 2).cursor(20, 7).build());
    snap = await session.waitForInput();
    assert.equal(snap.lines[0]!.trim(), 'Main menu');
    assert.ok(traced.includes('in') && traced.includes('out'));
  } finally {
    session.close();
    host.close();
  }
});

test('keys a 3270 lacks, and System Request, are refused without changing anything', async () => {
  const host = await fakeHost();
  const session = await connected(host);
  try {
    host.send(signOnScreen());
    await session.waitForInput();
    assert.throws(() => session.submit({ aid: 'PageDown', fields: { '5:30': 'IBMUSER' } }), /A 3270 has no PageDown key/);
    const user = session.snapshot().fields.find((f) => f.id === '5:30')!;
    assert.deepEqual([user.value, user.modified], ['', false]);
    assert.throws(() => session.submit({ aid: 'Enter', fields: { '9:9': 'x' } }), /No field 9:9/);
    assert.throws(() => session.systemRequest(), /not supported/);
    session.attention();
    await host.received(1);
    assert.deepEqual(host.raw[0], [IAC, 0xf4]);
  } finally {
    session.close();
    host.close();
  }
});

test('on an unformatted screen, a row:col id types at that position', async () => {
  const host = await fakeHost();
  const session = await connected(host);
  try {
    host.send(stream().eraseWrite().at(1, 1).chars('READY').cursor(2, 1).build());
    await session.waitForInput();
    session.submit({ aid: 'Enter', fields: { '2:1': 'TIME' } });
    await host.received(1);
    assert.deepEqual(host.records[0]!.slice(3), [...e('READY'), ...e('TIME')]);
    assert.throws(() => session.submit({ aid: 'Enter', fields: { '30:1': 'x' } }));
  } finally {
    session.close();
    host.close();
  }
});

test('an LU in use: the session tries the next name, then closes with DeviceNameInUseError', async () => {
  const host = await fakeHost({ busy: ['VENLU01', 'VENLU02'] });
  const names = ['VENLU02'];
  const session = new Session({ host: '127.0.0.1', port: host.port, deviceName: 'VENLU01', onDeviceNameInUse: () => names.shift() });
  try {
    const closed = once(session, 'close');
    await session.connect();
    const [err] = await closed;
    assert.ok(err instanceof DeviceNameInUseError);
    assert.equal((err as DeviceNameInUseError).deviceName, 'VENLU02');
    assert.deepEqual(host.lus, ['VENLU01', 'VENLU02']);
  } finally {
    session.close();
    host.close();
  }
});

test('a host without TN3270E gets plain TN3270, with the LU in the terminal type', async () => {
  const host = await fakeHost({ plain: true });
  const session = await connected(host, { terminalType: 'IBM-3278-4-E', deviceName: 'VENLU01' }, true);
  try {
    assert.equal(session.tn3270e, false);
    assert.deepEqual(host.terminalTypes, ['IBM-3278-4-E@VENLU01']);
    host.send(stream().eraseWrite({ alternate: { rows: 43, cols: 80 } }).text(43, 2, 'Bottom').input(42, 2, 4).cursor(42, 2).build());
    const snap = await session.waitForInput();
    assert.deepEqual([snap.rows, snap.lines[42]!.trim()], [43, 'Bottom']);
    session.submit({ aid: 'F3' });
    await host.received(1);
    assert.equal(host.raw[0]![0], 0xf3, 'no header: the AID comes first');
  } finally {
    session.close();
    host.close();
  }
});

test('an unsupported terminal type is refused up front', () => {
  assert.throws(() => new Session({ host: 'x', terminalType: 'IBM-3179-2' }), /not supported/);
});
