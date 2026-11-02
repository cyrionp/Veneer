// 3270 data stream interpreter: applies host writes to a Screen, answers the
// host's reads and queries, and builds what a key sends (Read Modified).

import type { Codepage } from '@veneer/terminal';
import { ADDRESS_CODES, decodeAddress, encodeAddress } from './address.ts';
import {
  Aid, FA, Order, QCode, ReadPartition, SF, SHORT_READ_AIDS, WCC, XA, commandName,
} from './constants.ts';
import { Screen, isProtected, type Field, type FieldAttribute } from './screen.ts';

export interface TerminalOptions {
  codepage: Codepage;
  /** 3278 model: 2 (24x80), 3 (32x80), 4 (43x80) or 5 (27x132). */
  model: number;
  /** Send an inbound 3270 data stream to the host. */
  send3270: (data: number[]) => void;
  /** Send text typed on the SSCP-LU session. */
  sendSscpLu: (data: number[]) => void;
  onWarning: (message: string) => void;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** The query replies we give, in the order the Summary lists them. */
const SUPPORTED_QUERIES = [
  QCode.SUMMARY, QCode.USABLE_AREA, QCode.CHARACTER_SETS, QCode.COLOR, QCode.HIGHLIGHT, QCode.REPLY_MODES, QCode.IMPLICIT_PARTITION,
] as const;

export class Terminal {
  readonly screen: Screen;
  private readonly opts: TerminalOptions;
  /** The last key sent, which host-initiated reads report. */
  private aid: number = Aid.NONE;
  /** Locked from connecting until the host first writes. */
  private awaitingFirst = true;
  /** Locked from sending a key until a write restores the keyboard. */
  private aidPending = false;
  /** On the SSCP-LU session (the VTAM logon screen), where input is plain text. */
  sscpLu = false;
  /** Where the host's last SSCP-LU output ended: input starts there. */
  private sscpStart = 0;

  constructor(opts: TerminalOptions) {
    this.opts = opts;
    this.screen = new Screen(opts.model);
  }

  private sync(): void {
    this.screen.keyboardLocked = this.awaitingFirst || this.aidPending;
  }

  private warn(message: string): void {
    this.opts.onWarning(message);
  }

  /** A 3270 data record from the host: a command and its data. */
  processRecord(data: Uint8Array): void {
    if (data.length === 0) return;
    this.sscpLu = false;
    const cmd = commandName(data[0]!);
    const rest = data.subarray(1);
    switch (cmd) {
      case 'W': this.write(rest, false, false); break;
      case 'EW': this.write(rest, true, false); break;
      case 'EWA': this.write(rest, true, true); break;
      case 'EAU': this.eraseAllUnprotected(); break;
      case 'WSF': this.structuredFields(rest); break;
      case 'RB': this.opts.send3270(this.readBuffer()); break;
      case 'RM': this.opts.send3270(this.readModified(this.aid)); break;
      case 'RMA': this.opts.send3270(this.readModified(this.aid, true)); break;
      case 'NOP': break;
      default: this.warn(`Unknown 3270 command 0x${data[0]!.toString(16)}`);
    }
    this.sync();
  }

  /**
   * Data on the SSCP-LU session: plain text, usually the logon screen. New
   * lines start a row; orders some hosts send anyway are skipped.
   */
  processSscpLu(data: Uint8Array): void {
    const s = this.screen;
    if (!this.sscpLu) { s.erase(); this.sscpLu = true; }
    let addr = this.awaitingFirst ? 0 : s.cursor;
    for (let i = 0; i < data.length; i++) {
      const b = data[i]!;
      if (b === Order.SF) i += 1;
      else if (b === Order.SBA) i += 2;
      else if (b === Order.IC) continue;
      else if (b === 0x15 || b === 0x25 || b === 0x0d) addr = s.next(addr - (addr % s.cols), s.cols);
      else { s.putChar(addr, b); addr = s.next(addr); }
    }
    s.cursor = addr;
    this.sscpStart = addr;
    this.awaitingFirst = false;
    this.aidPending = false;
    this.sync();
  }

  /** An application was bound to the LU: 3270 data from now on. */
  bind(): void {
    this.sscpLu = false;
  }

  /** The application let go of the LU: blank the screen until the host writes again. */
  unbind(): void {
    this.screen.erase();
    this.sscpLu = false;
    this.awaitingFirst = true;
    this.aidPending = false;
    this.sync();
  }

  // ---- Writes ------------------------------------------------------------

  private write(data: Uint8Array, erase: boolean, alternate: boolean): void {
    const s = this.screen;
    if (erase) s.erase(alternate);
    if (data.length === 0) { this.awaitingFirst = false; return; }
    const wcc = data[0]!;
    if (wcc & WCC.RESET_MDT) for (const a of s.attrs) if (a) a.fa &= ~FA.MDT;

    let addr = s.cursor;
    let color = 0;
    let highlight = 0;
    let lastData = false;
    let lastZeroPt = false;
    const need = (i: number, n: number) => {
      if (i + n < data.length) return true;
      this.warn('A write ends in the middle of an order');
      return false;
    };
    const address = (i: number) => {
      const a = decodeAddress(data[i]!, data[i + 1]!);
      if (a >= s.size) this.warn(`Buffer address ${a} is outside the ${s.rows}x${s.cols} screen`);
      return a % s.size;
    };

    let i = 1;
    while (i < data.length) {
      const b = data[i]!;
      let wasData = false;
      let zeroPt = false;
      switch (b) {
        case Order.SF:
          if (!need(i, 1)) return this.finishWrite(wcc);
          s.setAttribute(addr, { fa: data[i + 1]!, color: 0, highlight: 0, validation: 0 });
          addr = s.next(addr);
          i += 2;
          break;
        case Order.SFE: {
          if (!need(i, 1)) return this.finishWrite(wcc);
          const n = data[i + 1]!;
          if (!need(i, 1 + 2 * n)) return this.finishWrite(wcc);
          const attr: FieldAttribute = { fa: 0, color: 0, highlight: 0, validation: 0 };
          applyPairs(attr, data.subarray(i + 2, i + 2 + 2 * n));
          s.setAttribute(addr, attr);
          addr = s.next(addr);
          i += 2 + 2 * n;
          break;
        }
        case Order.MF: {
          if (!need(i, 1)) return this.finishWrite(wcc);
          const n = data[i + 1]!;
          if (!need(i, 1 + 2 * n)) return this.finishWrite(wcc);
          const attr = s.attrs[addr];
          if (attr) {
            applyPairs(attr, data.subarray(i + 2, i + 2 + 2 * n));
            addr = s.next(addr);
          }
          i += 2 + 2 * n;
          break;
        }
        case Order.SBA:
          if (!need(i, 2)) return this.finishWrite(wcc);
          addr = address(i + 1);
          i += 3;
          break;
        case Order.IC:
          s.cursor = addr;
          i += 1;
          break;
        case Order.PT: {
          const attr = s.attrs[addr];
          if (attr && !isProtected(attr)) {
            // On an input field's attribute: just step onto the field.
            addr = s.next(addr);
          } else {
            let target = s.nextUnprotected(addr);
            if (target < addr) target = 0;
            // After data, PT also nulls the rest of the field it was in.
            if (lastData || lastZeroPt) {
              while (addr !== target && !s.attrs[addr]) { s.putChar(addr, 0x00); addr = s.next(addr); }
            }
            addr = target;
            zeroPt = target === 0;
          }
          i += 1;
          break;
        }
        case Order.RA: {
          if (!need(i, 3)) return this.finishWrite(wcc);
          const stop = address(i + 1);
          let ch = data[i + 3]!;
          i += 4;
          if (ch === Order.GE) {
            if (i >= data.length) { this.warn('A write ends in the middle of an order'); return this.finishWrite(wcc); }
            ch = data[i]!;
            i += 1;
          }
          do { s.putChar(addr, ch, color, highlight); addr = s.next(addr); } while (addr !== stop);
          break;
        }
        case Order.EUA: {
          if (!need(i, 2)) return this.finishWrite(wcc);
          const stop = address(i + 1);
          // Null every position of an input field (or all, unformatted) up to the stop address.
          let governing = s.attributeOf(addr);
          do {
            if (s.attrs[addr]) governing = addr;
            else if (governing < 0 || !isProtected(s.attrs[governing]!)) s.putChar(addr, 0x00);
            addr = s.next(addr);
          } while (addr !== stop);
          i += 3;
          break;
        }
        case Order.SA: {
          if (!need(i, 2)) return this.finishWrite(wcc);
          const [type, value] = [data[i + 1]!, data[i + 2]!];
          if (type === XA.ALL) { color = 0; highlight = 0; }
          else if (type === XA.HIGHLIGHT) highlight = value;
          else if (type === XA.FOREGROUND) color = value;
          i += 3;
          break;
        }
        case Order.GE:
          if (!need(i, 1)) return this.finishWrite(wcc);
          s.putChar(addr, data[i + 1]!, color, highlight);
          addr = s.next(addr);
          i += 2;
          wasData = true;
          break;
        default:
          s.putChar(addr, b, color, highlight);
          addr = s.next(addr);
          i += 1;
          wasData = true;
      }
      lastData = wasData;
      lastZeroPt = zeroPt;
    }
    this.finishWrite(wcc);
  }

  private finishWrite(wcc: number): void {
    if (wcc & WCC.RESTORE) { this.aidPending = false; this.aid = Aid.NONE; }
    if (wcc & WCC.ALARM) this.screen.alarm = true;
    this.awaitingFirst = false;
  }

  private eraseAllUnprotected(): void {
    const s = this.screen;
    if (!s.formatted) {
      s.erase();
    } else {
      for (const f of s.fields()) {
        if (isProtected(f.attr)) continue;
        for (const p of s.positions(f)) s.putChar(p, 0x00);
        f.attr.fa &= ~FA.MDT;
      }
      s.cursor = s.firstUnprotected();
    }
    this.aidPending = false;
    this.aid = Aid.NONE;
    this.awaitingFirst = false;
  }

  // ---- Structured fields -------------------------------------------------

  private structuredFields(data: Uint8Array): void {
    let i = 0;
    while (i < data.length) {
      if (i + 3 > data.length) { this.warn('A structured field is cut short'); return; }
      let length = (data[i]! << 8) | data[i + 1]!;
      if (length === 0) length = data.length - i;
      if (length < 3 || i + length > data.length) { this.warn(`A structured field has a bad length (${length})`); return; }
      const id = data[i + 2]!;
      const body = data.subarray(i + 3, i + length);
      switch (id) {
        case SF.READ_PARTITION: this.readPartition(body); break;
        case SF.ERASE_RESET:
          this.screen.erase(((body[0] ?? 0) & 0x80) !== 0);
          this.awaitingFirst = false;
          break;
        case SF.SET_REPLY_MODE:
          if ((body[1] ?? 0) !== 0x00) this.warn(`Reply mode 0x${(body[1] ?? 0).toString(16)} is not supported; staying in field mode`);
          break;
        case SF.OUTBOUND_3270DS: {
          const cmd = commandName(body[1] ?? -1);
          if (cmd === 'W' || cmd === 'EW' || cmd === 'EWA' || cmd === 'EAU') this.processRecord(body.subarray(1));
          else this.warn(`Outbound 3270DS with command 0x${(body[1] ?? 0).toString(16)} is not supported`);
          break;
        }
        default:
          this.warn(`Structured field 0x${id.toString(16)} is not supported`);
      }
      i += length;
    }
  }

  private readPartition(body: Uint8Array): void {
    const [pid, type] = [body[0], body[1]];
    if (pid === 0xff && type === ReadPartition.QUERY) return this.opts.send3270(this.queryReply());
    if (pid === 0xff && type === ReadPartition.QUERY_LIST) {
      const requestType = body[2] ?? 0x80;
      const asked = requestType === 0x00 ? [...body.subarray(3)] : undefined;
      return this.opts.send3270(this.queryReply(asked));
    }
    if (type === ReadPartition.RB) return this.opts.send3270(this.readBuffer());
    if (type === ReadPartition.RM) return this.opts.send3270(this.readModified(this.aid));
    if (type === ReadPartition.RMA) return this.opts.send3270(this.readModified(this.aid, true));
    this.warn(`Read Partition type 0x${(type ?? 0).toString(16)} is not supported`);
  }

  /** Query replies: all we support, or those asked for in a Query List. */
  queryReply(asked?: number[]): number[] {
    const codes = asked
      ? SUPPORTED_QUERIES.filter((c) => asked.includes(c))
      : [...SUPPORTED_QUERIES];
    const out: number[] = [Aid.STRUCTURED_FIELD];
    if (codes.length === 0) return [...out, ...queryReplyField(QCode.NULL, [])];
    for (const c of codes) out.push(...queryReplyField(c, this.queryData(c)));
    return out;
  }

  private queryData(code: number): number[] {
    const { rows, cols } = this.screen.alternate;
    const be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
    switch (code) {
      case QCode.SUMMARY: return [...SUPPORTED_QUERIES];
      case QCode.USABLE_AREA:
        // 12/14-bit addressing; size; units mm, Xr, Yr; character cell 9x12; buffer size.
        return [0x01, 0x00, ...be(cols), ...be(rows), 0x01, 0x00, 0x0a, 0x02, 0xe5, 0x00, 0x02, 0x00, 0x6f, 0x09, 0x0c, ...be(rows * cols)];
      case QCode.CHARACTER_SETS:
        // Graphic escape; 9x12 cells; one descriptor each for the base set
        // (GCSGID 697 with this code page) and the APL set used by GE.
        return [
          0x82, 0x00, 0x09, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x07,
          0x00, 0x10, 0x00, 0x02, 0xb9, ...be(this.opts.codepage.ccsid),
          0x01, 0x10, 0xf1, 0x03, 0xc3, 0x01, 0x36,
        ];
      case QCode.COLOR: {
        // Eight colours: the default is green, then blue to white as themselves.
        const out = [0x00, 0x08, 0x00, 0xf4];
        for (let c = 0xf1; c <= 0xf7; c++) out.push(c, c);
        return out;
      }
      case QCode.HIGHLIGHT:
        return [0x05, 0x00, 0xf0, 0xf1, 0xf1, 0xf2, 0xf2, 0xf4, 0xf4, 0xf8, 0xf8];
      case QCode.REPLY_MODES:
        return [0x00]; // field mode only
      case QCode.IMPLICIT_PARTITION:
        return [0x00, 0x00, 0x0b, 0x01, 0x00, ...be(80), ...be(24), ...be(cols), ...be(rows)];
      default:
        return [];
    }
  }

  // ---- Input ------------------------------------------------------------

  /** Type into an input field, as Erase EOF then typing would. Returns false if unchanged. */
  setFieldValue(field: Field, value: string): boolean {
    if (isProtected(field.attr)) throw new ProtocolError('Cannot type into a protected field');
    const s = this.screen;
    const bytes = this.opts.codepage.encode(value.replace(/\s+$/, '')).slice(0, field.length);
    const positions = s.positions(field);
    const blank = (b: number) => (b === 0x00 ? 0x40 : b);
    if (positions.every((p, k) => blank(s.buffer[p]!) === blank(bytes[k] ?? 0x00))) return false;
    positions.forEach((p, k) => s.putChar(p, bytes[k] ?? 0x00));
    field.attr.fa |= FA.MDT;
    return true;
  }

  /** Type text at an address on an unformatted screen. */
  writeText(address: number, text: string): void {
    const s = this.screen;
    let a = address;
    for (const b of this.opts.codepage.encode(text)) { s.putChar(a, b); a = s.next(a); }
  }

  /** Press a key: send it with the cursor and changed fields, then wait for the host. */
  sendAid(aid: number): void {
    const s = this.screen;
    if (this.sscpLu) {
      if (aid === Aid.CLEAR) { s.erase(); this.sscpStart = 0; return; }
      if (aid !== Aid.ENTER) throw new ProtocolError('Only Enter and Clear work on the logon screen');
      const out: number[] = [];
      for (let a = this.sscpStart; a < s.size; a++) if (s.buffer[a] !== 0x00) out.push(s.buffer[a]!);
      this.opts.sendSscpLu(out);
    } else {
      this.opts.send3270(this.readModified(aid));
      // Clear blanks the screen and returns it to the default size.
      if (aid === Aid.CLEAR) s.erase();
    }
    this.aid = aid;
    this.aidPending = true;
    this.sync();
  }

  /** Read Modified: the AID, the cursor and each changed field (nulls left out). */
  readModified(aid: number, all = false): number[] {
    const s = this.screen;
    const out = [aid];
    if (SHORT_READ_AIDS.has(aid) && !all) return out;
    out.push(...encodeAddress(s.cursor, s.size));
    if (!s.formatted) {
      for (const b of s.buffer) if (b !== 0x00) out.push(b);
      return out;
    }
    for (const f of s.fields()) {
      if (!(f.attr.fa & FA.MDT)) continue;
      out.push(Order.SBA, ...encodeAddress(f.start, s.size));
      for (const p of s.positions(f)) if (s.buffer[p] !== 0x00) out.push(s.buffer[p]!);
    }
    return out;
  }

  /** Read Buffer: the AID, the cursor and every position, attributes as SF orders. */
  readBuffer(): number[] {
    const s = this.screen;
    const out = [this.aid, ...encodeAddress(s.cursor, s.size)];
    for (let a = 0; a < s.size; a++) {
      const attr = s.attrs[a];
      if (attr) out.push(Order.SF, ADDRESS_CODES[attr.fa & 0x3f]!);
      else out.push(s.buffer[a]!);
    }
    return out;
  }
}

function applyPairs(attr: FieldAttribute, pairs: Uint8Array): void {
  for (let k = 0; k + 1 < pairs.length; k += 2) {
    const [type, value] = [pairs[k]!, pairs[k + 1]!];
    if (type === XA.FIELD) attr.fa = value;
    else if (type === XA.HIGHLIGHT) attr.highlight = value;
    else if (type === XA.FOREGROUND) attr.color = value;
    else if (type === XA.VALIDATION) attr.validation = value;
    else if (type === XA.ALL) { attr.highlight = 0; attr.color = 0; }
  }
}

function queryReplyField(code: number, data: number[]): number[] {
  const length = data.length + 4;
  return [length >> 8, length & 0xff, 0x81, code, ...data];
}
