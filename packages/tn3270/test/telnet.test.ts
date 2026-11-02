import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeviceNameInUseError } from '@veneer/terminal';
import { TelnetCodec, type RecordKind, type TelnetOptions } from '../src/telnet.ts';

const IAC = 0xff, DO = 0xfd, DONT = 0xfe, WILL = 0xfb, WONT = 0xfc, SB = 0xfa, SE = 0xf0, EOR = 0xef;
const TTYPE = 0x18, TN3270E = 0x28;
// TN3270E words
const CONNECT = 0x01, DEVICE_TYPE = 0x02, FUNCTIONS = 0x03, IS = 0x04, REASON = 0x05, REJECT = 0x06, REQUEST = 0x07, SEND = 0x08;
const ascii = (s: string) => [...Buffer.from(s, 'ascii')];
const sub = (option: number, ...body: number[]) => [IAC, SB, option, ...body, IAC, SE];

function codec(opts: Partial<TelnetOptions> = {}) {
  const sent: number[][] = [];
  const records: Array<[RecordKind, number[]]> = [];
  const failures: Error[] = [];
  const traced: Array<[string, number[]]> = [];
  const c = new TelnetCodec({
    terminalType: 'IBM-3278-2-E',
    send: (b) => sent.push([...b]),
    onRecord: (kind, data) => records.push([kind, [...data]]),
    onFailure: (err) => failures.push(err),
    trace: (dir, rec) => traced.push([dir, [...rec]]),
    ...opts,
  });
  const host = (...bytes: number[]) => c.receive(Buffer.from(bytes));
  return { c, sent, records, failures, traced, host };
}

/** Run the TN3270E negotiation up to an agreed set of functions. */
function negotiated(opts: Partial<TelnetOptions> = {}) {
  const t = codec(opts);
  t.host(IAC, DO, TN3270E);
  t.host(...sub(TN3270E, SEND, DEVICE_TYPE));
  t.host(...sub(TN3270E, DEVICE_TYPE, IS, ...ascii('IBM-3278-2-E'), CONNECT, ...ascii('LU000042')));
  t.host(...sub(TN3270E, FUNCTIONS, IS, 0x00, 0x02));
  t.sent.length = 0;
  return t;
}

test('TN3270E: asks for the device type and LU, then the functions', () => {
  const { c, sent, host } = codec({ deviceName: 'VENLU01' });
  host(IAC, DO, TN3270E);
  assert.deepEqual(sent.shift(), [IAC, WILL, TN3270E]);
  host(...sub(TN3270E, SEND, DEVICE_TYPE));
  assert.deepEqual(sent.shift(), sub(TN3270E, DEVICE_TYPE, REQUEST, ...ascii('IBM-3278-2-E'), CONNECT, ...ascii('VENLU01')));
  host(...sub(TN3270E, DEVICE_TYPE, IS, ...ascii('IBM-3278-2-E'), CONNECT, ...ascii('VENLU01')));
  assert.deepEqual(sent.shift(), sub(TN3270E, FUNCTIONS, REQUEST, 0x00, 0x02), 'BIND-IMAGE and RESPONSES');
  assert.equal(c.tn3270e, false, 'not until the functions are agreed');
  host(...sub(TN3270E, FUNCTIONS, IS, 0x00, 0x02));
  assert.equal(c.tn3270e, true);
  assert.deepEqual(c.agreedFunctions, [0x00, 0x02]);
  assert.equal(c.deviceName, 'VENLU01');
  assert.deepEqual(sent, []);
});

test('TN3270E without an LU name lets the host pick one, and reports it', () => {
  const { c, sent, host } = codec();
  host(IAC, DO, TN3270E, ...sub(TN3270E, SEND, DEVICE_TYPE));
  assert.deepEqual(sent[1], sub(TN3270E, DEVICE_TYPE, REQUEST, ...ascii('IBM-3278-2-E')));
  host(...sub(TN3270E, DEVICE_TYPE, IS, ...ascii('IBM-3278-2-E'), CONNECT, ...ascii('TCP00017')));
  assert.equal(c.deviceName, 'TCP00017');
});

test('TN3270E: a host counter-proposal is accepted if we support it all, else narrowed', () => {
  const t = codec();
  t.host(IAC, DO, TN3270E, ...sub(TN3270E, FUNCTIONS, REQUEST, 0x00));
  assert.deepEqual(t.sent.at(-1), sub(TN3270E, FUNCTIONS, IS, 0x00));
  assert.equal(t.c.tn3270e, true);
  const u = codec();
  u.host(IAC, DO, TN3270E, ...sub(TN3270E, FUNCTIONS, REQUEST, 0x00, 0x04));
  assert.deepEqual(u.sent.at(-1), sub(TN3270E, FUNCTIONS, REQUEST, 0x00), 'SYSREQ is not supported');
  assert.equal(u.c.tn3270e, false);
});

test('TN3270E records carry a header: data types are told apart and the header is stripped', () => {
  const { records, host } = negotiated();
  host(0x00, 0x00, 0x00, 0x00, 0x01, 0xf5, 0x02, IAC, EOR);
  host(0x07, 0x00, 0x00, 0x00, 0x02, 0xc8, 0xc9, IAC, EOR);
  host(0x03, 0x00, 0x00, 0x00, 0x03, 0x31, IAC, EOR);
  host(0x04, 0x00, 0x00, 0x00, 0x04, 0x01, IAC, EOR);
  host(0x05, 0x00, 0x00, 0x00, 0x05, 0x41, IAC, EOR);
  assert.deepEqual(records, [['3270', [0xf5, 0x02]], ['sscp-lu', [0xc8, 0xc9]], ['bind', [0x31]], ['unbind', [0x01]], ['other', [0x41]]]);
});

test('TN3270E: outbound records get a header and IAC is doubled everywhere', () => {
  const { c, sent, traced } = negotiated();
  c.send3270(Uint8Array.from([0x7d, 0xff, 0x40]));
  assert.deepEqual(sent[0], [0x00, 0x00, 0x00, 0x00, 0x01, 0x7d, IAC, IAC, 0x40, IAC, EOR]);
  c.sendSscpLu(Uint8Array.from([0xc1]));
  assert.deepEqual(sent[1], [0x07, 0x00, 0x00, 0x00, 0x02, 0xc1, IAC, EOR]);
  assert.deepEqual(traced.at(-1), ['out', [0x07, 0x00, 0x00, 0x00, 0x02, 0xc1]], 'traces the record, unescaped');
});

test('TN3270E responses: positive when asked always, negative when processing fails', () => {
  const t = negotiated();
  t.host(0x00, 0x00, 0x02, 0x12, 0x34, 0xf1, 0x02, IAC, EOR);
  assert.deepEqual(t.sent.at(-1), [0x02, 0x00, 0x00, 0x12, 0x34, 0x00, IAC, EOR], 'positive, same sequence number, device end');
  t.host(0x00, 0x00, 0x01, 0x00, 0x09, 0xf1, 0x02, IAC, EOR);
  assert.equal(t.sent.length, 1, 'error-response only: nothing when it worked');
  t.host(0x00, 0x00, 0x00, 0x00, 0x0a, 0xf1, 0x02, IAC, EOR);
  assert.equal(t.sent.length, 1, 'no response asked');

  const failing = negotiated({ onRecord: () => { throw new Error('bad'); } });
  failing.host(0x00, 0x00, 0x01, 0x00, 0x0b, 0x99, IAC, EOR);
  assert.deepEqual(failing.sent.at(-1), [0x02, 0x00, 0x01, 0x00, 0x0b, 0x00, IAC, EOR], 'negative: command reject');
  // A sequence number with an IAC in it is doubled on the way back.
  failing.host(0x00, 0x00, 0x02, 0x00, IAC, IAC, 0x01, IAC, EOR);
  assert.deepEqual(failing.sent.at(-1), [0x02, 0x00, 0x01, 0x00, IAC, IAC, 0x00, IAC, EOR]);
});

test('without the RESPONSES function, no responses are sent', () => {
  const t = codec();
  t.host(IAC, DO, TN3270E, ...sub(TN3270E, FUNCTIONS, IS, 0x00));
  t.sent.length = 0;
  t.host(0x00, 0x00, 0x02, 0x00, 0x01, 0xf1, 0x02, IAC, EOR);
  assert.deepEqual(t.sent, []);
});

test('an LU in use: another name is tried, then the session gives up', () => {
  const names = ['VENLU02'];
  const offered: string[] = [];
  const t = codec({ deviceName: 'VENLU01', onDeviceNameInUse: (n) => { offered.push(n); return names.shift(); } });
  t.host(IAC, DO, TN3270E, ...sub(TN3270E, SEND, DEVICE_TYPE));
  t.host(...sub(TN3270E, DEVICE_TYPE, REJECT, REASON, 0x01));
  assert.deepEqual(t.sent.at(-1), sub(TN3270E, DEVICE_TYPE, REQUEST, ...ascii('IBM-3278-2-E'), CONNECT, ...ascii('VENLU02')));
  assert.equal(t.c.deviceName, 'VENLU02');
  t.host(...sub(TN3270E, DEVICE_TYPE, REJECT, REASON, 0x01));
  assert.deepEqual(offered, ['VENLU01', 'VENLU02']);
  assert.equal(t.failures.length, 1);
  assert.ok(t.failures[0] instanceof DeviceNameInUseError);
  assert.equal(t.c.refusedDeviceName, 'VENLU02');
});

test('an unknown LU, or no free LU, ends the session with a clear error', () => {
  const t = codec({ deviceName: 'NOSUCH' });
  t.host(IAC, DO, TN3270E, ...sub(TN3270E, SEND, DEVICE_TYPE), ...sub(TN3270E, DEVICE_TYPE, REJECT, REASON, 0x03));
  assert.match(t.failures[0]!.message, /LU NOSUCH is not known/);
  const u = codec();
  u.host(IAC, DO, TN3270E, ...sub(TN3270E, SEND, DEVICE_TYPE), ...sub(TN3270E, DEVICE_TYPE, REJECT, REASON, 0x01));
  assert.match(u.failures[0]!.message, /no free LU/);
});

test('any other rejection falls back to plain TN3270, which names the LU as TYPE@LU', () => {
  const t = codec({ deviceName: 'VENLU01' });
  t.host(IAC, DO, TN3270E, ...sub(TN3270E, SEND, DEVICE_TYPE), ...sub(TN3270E, DEVICE_TYPE, REJECT, REASON, 0x04));
  assert.deepEqual(t.sent.at(-1), [IAC, WONT, TN3270E]);
  assert.deepEqual(t.failures, []);
  t.sent.length = 0;
  t.host(IAC, DO, TTYPE, ...sub(TTYPE, 0x01), IAC, DO, 0x19, IAC, WILL, 0x19, IAC, DO, 0x00, IAC, WILL, 0x00);
  assert.deepEqual(t.sent, [
    [IAC, WILL, TTYPE],
    sub(TTYPE, 0x00, ...ascii('IBM-3278-2-E@VENLU01')),
    [IAC, WILL, 0x19], [IAC, DO, 0x19], [IAC, WILL, 0x00], [IAC, DO, 0x00],
  ]);
  t.host(0xf5, 0x02, IAC, EOR);
  assert.deepEqual(t.records, [['3270', [0xf5, 0x02]]], 'plain TN3270 records have no header');
  assert.equal(t.c.tn3270e, false);
});

test('TN3270E can be turned off, and a host can switch it off', () => {
  const off = codec({ tn3270e: false });
  off.host(IAC, DO, TN3270E);
  assert.deepEqual(off.sent, [[IAC, WONT, TN3270E]]);
  const t = negotiated();
  t.host(IAC, DONT, TN3270E);
  assert.deepEqual(t.sent, [[IAC, WONT, TN3270E]]);
  assert.equal(t.c.tn3270e, false);
});

test('unknown options are refused; Attention is Interrupt Process', () => {
  const t = codec();
  t.host(IAC, DO, 0x01, IAC, WILL, 0x03);
  assert.deepEqual(t.sent, [[IAC, WONT, 0x01], [IAC, DONT, 0x03]]);
  t.c.sendAttention();
  assert.deepEqual(t.sent.at(-1), [IAC, 0xf4]);
});

test('records are framed across chunks and traced as received', () => {
  const t = negotiated();
  t.host(0x00, 0x00, 0x00);
  t.host(0x00, 0x07, 0xf1, IAC);
  t.host(IAC, 0x02, IAC, EOR);
  assert.deepEqual(t.records, [['3270', [0xf1, 0xff, 0x02]]]);
  assert.deepEqual(t.traced.at(-1), ['in', [0x00, 0x00, 0x00, 0x00, 0x07, 0xf1, 0xff, 0x02]]);
});
