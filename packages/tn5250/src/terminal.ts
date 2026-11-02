// 5250 data stream interpreter: applies host records to a Screen and builds
// the inbound records (AID responses, query reply, save screen) sent back.

import { fieldId } from '@veneer/terminal';
import {
  AIDS_WITHOUT_DATA, Aid, Command, ESC, HeaderFlag, Opcode, Order, RECORD_TYPE_DISPLAY,
} from './constants.ts';
import type { Codepage } from '@veneer/terminal';
import { FFW, Screen, fieldAdjust, fieldShift, isAttributeByte, type Field } from './screen.ts';

export interface TerminalOptions {
  codepage: Codepage;
  terminalType: string;
  /** Called with each complete inbound 5250 record (before Telnet framing). */
  sendRecord: (record: Buffer) => void;
  onWarning?: (message: string) => void;
}

export class ProtocolError extends Error {}

export function buildRecord(opcode: number, data: ArrayLike<number> = [], flags = 0): Buffer {
  const len = 10 + data.length;
  const rec = Buffer.alloc(len);
  rec.writeUInt16BE(len, 0);
  rec.writeUInt16BE(RECORD_TYPE_DISPLAY, 2);
  rec[6] = 0x04; // variable header length
  rec[7] = flags;
  rec[8] = 0x00;
  rec[9] = opcode;
  rec.set(Array.from(data), 10);
  return rec;
}

export class Terminal {
  readonly screen = new Screen();
  private readonly opts: TerminalOptions;
  /** The Read command awaiting an AID key, if any. */
  private pendingRead: number | null = null;
  /** The first SF after a Read command clears the format table. */
  private clearFormatTableOnSF = false;
  /** Cursor position set by an IC order, applied when the keyboard unlocks. */
  private insertCursor: number | null = null;

  constructor(opts: TerminalOptions) {
    this.opts = opts;
  }

  get readPending(): boolean {
    return this.pendingRead !== null;
  }

  // ---------------------------------------------------------------- outbound

  processRecord(rec: Uint8Array): void {
    if (rec.length < 10) throw new ProtocolError(`Record too short (${rec.length} bytes)`);
    const view = Buffer.from(rec.buffer, rec.byteOffset, rec.byteLength);
    const type = view.readUInt16BE(2);
    if (type !== RECORD_TYPE_DISPLAY) {
      this.warn(`Ignoring record type 0x${type.toString(16)}`);
      return;
    }
    const varLen = view[6]!;
    const opcode = view[6 + varLen - 1]!;
    const data = view.subarray(6 + varLen);

    switch (opcode) {
      case Opcode.CANCEL_INVITE:
        this.pendingRead = null;
        this.opts.sendRecord(buildRecord(Opcode.CANCEL_INVITE));
        return;
      case Opcode.MESSAGE_LIGHT_ON: this.screen.messageWaiting = true; break;
      case Opcode.MESSAGE_LIGHT_OFF: this.screen.messageWaiting = false; break;
      case Opcode.SAVE_SCREEN:
        if (data.length === 0) { this.sendSaveScreen(); return; }
        break;
    }
    this.processCommands(data);
  }

  private processCommands(data: Buffer): void {
    let i = 0;
    while (i < data.length) {
      if (data[i] !== ESC) {
        this.warn(`Expected ESC at offset ${i}, got 0x${data[i]!.toString(16)}; skipping`);
        i++;
        continue;
      }
      const cmd = data[i + 1];
      i += 2;
      switch (cmd) {
        case Command.CLEAR_UNIT:
          this.screen.clear(24, 80);
          this.pendingRead = null;
          this.insertCursor = null;
          break;
        case Command.CLEAR_UNIT_ALTERNATE: {
          const param = data[i++];
          if (param === 0x00) this.screen.clear(27, 132);
          else this.screen.clear(24, 80);
          this.pendingRead = null;
          this.insertCursor = null;
          break;
        }
        case Command.CLEAR_FORMAT_TABLE:
          this.screen.clearFormatTable();
          break;
        case Command.WRITE_TO_DISPLAY: {
          const cc1 = data[i]!, cc2 = data[i + 1]!;
          i = this.writeToDisplay(data, i + 2, cc1, cc2);
          break;
        }
        case Command.WRITE_ERROR_CODE:
          i = this.writeErrorCode(data, i);
          break;
        case Command.WRITE_ERROR_CODE_WINDOW:
          i = this.writeErrorCode(data, i + 2); // skip start/end column
          break;
        case Command.READ_INPUT_FIELDS:
        case Command.READ_MDT_FIELDS:
        case Command.READ_MDT_FIELDS_ALT: {
          const cc1 = data[i]!, cc2 = data[i + 1]!;
          i += 2;
          this.applyCc1(cc1);
          this.pendingRead = cmd;
          this.clearFormatTableOnSF = true;
          this.applyCc2(cc2);
          break;
        }
        case Command.READ_IMMEDIATE:
          this.sendFields(Command.READ_INPUT_FIELDS, 0x00, Opcode.NO_OP);
          break;
        case Command.READ_SCREEN_IMMEDIATE:
          this.opts.sendRecord(buildRecord(Opcode.NO_OP, this.screen.buffer));
          break;
        case Command.SAVE_SCREEN:
          this.sendSaveScreen();
          break;
        case Command.RESTORE_SCREEN:
          // The data that follows is the stream we produced for Save Screen.
          break;
        case Command.ROLL:
          this.roll(data[i]!, data[i + 1]!, data[i + 2]!);
          i += 3;
          break;
        case Command.WRITE_STRUCTURED_FIELD:
          i = this.writeStructuredField(data, i);
          break;
        default:
          this.warn(`Unsupported command 0x${cmd?.toString(16)}; ignoring rest of record`);
          return;
      }
    }
  }

  private writeToDisplay(data: Buffer, i: number, cc1: number, cc2: number): number {
    const s = this.screen;
    this.applyCc1(cc1);
    let addr = s.cursor;

    while (i < data.length && data[i] !== ESC) {
      const b = data[i++]!;
      switch (b) {
        case Order.SOH: {
          const len = data[i++]!;
          const params = data.subarray(i, i + len);
          i += len;
          s.errorRow = params[3] ?? 0;
          s.clearFormatTable();
          this.clearFormatTableOnSF = false;
          break;
        }
        case Order.RA: {
          const target = s.address(data[i]!, data[i + 1]!);
          const ch = data[i + 2]!;
          i += 3;
          while (true) {
            s.buffer[addr] = ch;
            if (addr === target) break;
            addr = (addr + 1) % s.size;
          }
          addr = (addr + 1) % s.size;
          break;
        }
        case Order.EA: {
          const target = s.address(data[i]!, data[i + 1]!);
          const len = data[i + 2]!; // includes the length byte itself
          i += 2 + len;
          while (true) {
            s.buffer[addr] = 0x00;
            if (addr === target) break;
            addr = (addr + 1) % s.size;
          }
          addr = (addr + 1) % s.size;
          break;
        }
        case Order.TD: {
          const len = data.readUInt16BE(i);
          i += 2;
          for (let k = 0; k < len; k++) {
            s.buffer[addr] = data[i + k]!;
            addr = (addr + 1) % s.size;
          }
          i += len;
          break;
        }
        case Order.SBA:
          addr = s.address(data[i]!, data[i + 1]!);
          i += 2;
          break;
        case Order.WEA:
          i += 2; // Extended attributes are not used by color 5250 displays.
          break;
        case Order.IC:
          this.insertCursor = s.address(data[i]!, data[i + 1]!);
          i += 2;
          break;
        case Order.MC:
          s.cursor = s.address(data[i]!, data[i + 1]!);
          i += 2;
          break;
        case Order.WDSF: {
          // Windows, selection fields, scroll bars: not rendered yet.
          const len = data.readUInt16BE(i);
          this.warn(`Skipping WDSF (${len} bytes)`);
          i += len;
          break;
        }
        case Order.SF: {
          let ffw = 0;
          const fcws: number[] = [];
          if ((data[i]! & 0xe0) !== 0x20) {
            ffw = data.readUInt16BE(i);
            i += 2;
            while ((data[i]! & 0xe0) !== 0x20) {
              fcws.push(data.readUInt16BE(i));
              i += 2;
            }
          }
          const attr = data[i++]!;
          const length = data.readUInt16BE(i);
          i += 2;
          s.buffer[addr] = attr;
          addr = (addr + 1) % s.size;
          if (ffw !== 0) {
            if (this.clearFormatTableOnSF) {
              s.clearFormatTable();
              this.clearFormatTableOnSF = false;
            }
            s.defineField({ start: addr, length, ffw, fcws, attr });
          }
          break;
        }
        default:
          s.buffer[addr] = b;
          addr = (addr + 1) % s.size;
      }
    }

    this.applyCc2(cc2);
    return i;
  }

  private writeErrorCode(data: Buffer, i: number): number {
    const s = this.screen;
    const row = s.effectiveErrorRow();
    const start = s.address(row, 1);
    if (!s.error) s.error = { row, saved: s.buffer.slice(start, start + s.cols) };
    // Clear the line so a shorter message does not leave old text behind.
    s.buffer.fill(0x00, start, start + s.cols);
    let addr = start;
    while (i < data.length && data[i] !== ESC) {
      const b = data[i++]!;
      if (b === Order.IC) {
        this.insertCursor = s.address(data[i]!, data[i + 1]!);
        i += 2;
      } else if (b === Order.SBA) {
        addr = s.address(data[i]!, data[i + 1]!);
        i += 2;
      } else {
        s.buffer[addr] = b;
        addr = (addr + 1) % s.size;
      }
    }
    s.keyboardLocked = true;
    return i;
  }

  private writeStructuredField(data: Buffer, i: number): number {
    const len = data.readUInt16BE(i);
    const cls = data[i + 2], type = data[i + 3];
    if (cls === 0xd9 && type === 0x70) this.sendQueryReply();
    else this.warn(`Ignoring structured field class 0x${cls?.toString(16)} type 0x${type?.toString(16)}`);
    return i + len;
  }

  private roll(control: number, top: number, bottom: number): void {
    const s = this.screen;
    let lines = control & 0x1f;
    if ((control & 0x80) === 0) lines = -lines; // 0x80 = roll down
    const rows = Array.from({ length: bottom - top + 1 }, (_, k) =>
      s.buffer.slice(s.address(top + k, 1), s.address(top + k, 1) + s.cols));
    for (let k = 0; k < rows.length; k++) {
      const src = k - lines;
      const row = src >= 0 && src < rows.length ? rows[src]! : new Uint8Array(s.cols);
      s.buffer.set(row, s.address(top + k, 1));
    }
  }

  private applyCc1(cc1: number): void {
    const s = this.screen;
    const op = cc1 & 0xe0;
    if (op === 0) return;
    s.keyboardLocked = true;
    const nonBypass = (f: Field) => (f.ffw & FFW.BYPASS) === 0;
    const mdt = (f: Field) => (f.ffw & FFW.MDT) !== 0;
    const nullField = (f: Field) => s.fieldBytes(f).fill(0x00);
    const resetMdt = (f: Field) => { f.ffw &= ~FFW.MDT; };
    for (const f of s.fields) {
      switch (op) {
        case 0x40: if (nonBypass(f)) resetMdt(f); break;
        case 0x60: resetMdt(f); break;
        case 0x80: if (nonBypass(f) && mdt(f)) nullField(f); break;
        case 0xa0: if (nonBypass(f)) { if (mdt(f)) nullField(f); resetMdt(f); } break;
        case 0xc0: if (nonBypass(f)) { nullField(f); resetMdt(f); } break;
        case 0xe0: if (nonBypass(f)) nullField(f); resetMdt(f); break;
      }
    }
  }

  private applyCc2(cc2: number): void {
    const s = this.screen;
    if (cc2 & 0x04) s.alarm = true;
    if (cc2 & 0x02) s.messageWaiting = false;
    if (cc2 & 0x01) s.messageWaiting = true;
    if (cc2 & 0x08) this.unlockKeyboard();
  }

  private unlockKeyboard(): void {
    const s = this.screen;
    s.keyboardLocked = false;
    if (this.insertCursor !== null) s.cursor = this.insertCursor;
    else s.cursor = s.firstInputField()?.start ?? 0;
    this.insertCursor = null;
  }

  // ----------------------------------------------------------------- inbound

  /**
   * Store user input in a field, applying monocase, right-adjust and sign rules.
   * Numeric fields accept a leading or trailing "-" for negative values.
   * Returns false when the field already holds exactly this data (MDT is left alone).
   */
  setFieldValue(field: Field, value: string): boolean {
    const s = this.screen;
    const out = this.encodeField(field, value);
    const current = s.fieldBytes(field);
    const blank = (b: number) => (b === 0x00 ? 0x40 : b);
    if (out.every((b, i) => blank(b) === blank(current[i] ?? 0x00))) return false;
    if ((field.ffw & FFW.BYPASS) !== 0) throw new ProtocolError('Cannot write to a bypass field');
    current.set(out);
    field.ffw |= FFW.MDT;
    return true;
  }

  private encodeField(field: Field, value: string): Uint8Array {
    const cp = this.opts.codepage;
    const shift = fieldShift(field);
    const adjust = fieldAdjust(field);
    const out = new Uint8Array(field.length); // nulls
    let text = value.replace(/\s+$/, '');
    if (field.ffw & FFW.MONOCASE) text = text.toUpperCase();

    const numeric = shift === 'signedNumeric' || shift === 'numericOnly';
    let negative = false;
    if (numeric) {
      text = text.trim();
      negative = /^-|-$/.test(text);
      text = text.replace(/^[-+]|[-+]$/, '').trim();
    }
    // Signed numeric fields take digits only; IBM i rejects anything else
    // (CPF0886), including a decimal point, which the field implies.
    if (shift === 'signedNumeric' && /[^0-9]/.test(text)) {
      const { row, col } = this.screen.rowCol(field.start);
      throw new ProtocolError(`Field ${fieldId(row, col)} takes digits only (type 1250 for 12.50)`);
    }
    // Signed numeric fields reserve the last position for the sign.
    const width = shift === 'signedNumeric' ? field.length - 1 : field.length;
    const bytes = cp.encode(text).slice(0, width);
    const rightAdjust = adjust === 'zeroFill' || adjust === 'blankFill' || shift === 'signedNumeric' || negative;
    if (rightAdjust && (text !== '' || adjust !== 'none')) {
      out.fill(adjust === 'zeroFill' ? 0xf0 : 0x40, 0, width - bytes.length);
      out.set(bytes, width - bytes.length);
    } else {
      out.set(bytes);
    }

    if (shift === 'signedNumeric') {
      if (negative) out[field.length - 1] = 0x60; // '-'
      else if (text !== '') out[field.length - 1] = 0x40;
    } else if (negative) {
      // Numeric-only: a negative value is the last digit with a D zone.
      const last = out[field.length - 1]!;
      if (last >= 0xf0 && last <= 0xf9) out[field.length - 1] = 0xd0 | (last & 0x0f);
    }
    return out;
  }

  /** Field data as sent to the host: signed numeric sign folded into the last digit's zone. */
  private fieldData(f: Field): number[] {
    const bytes = Array.from(this.screen.fieldBytes(f));
    if (fieldShift(f) !== 'signedNumeric' || bytes.length < 2) return bytes;
    const sign = bytes.pop()!;
    const last = bytes[bytes.length - 1]!;
    if (sign === 0x60 && last >= 0xf0 && last <= 0xf9) bytes[bytes.length - 1] = 0xd0 | (last & 0x0f);
    return bytes;
  }

  /** Send an AID key with the current field contents, as the pending Read requests. */
  sendAid(aid: number): void {
    if (this.pendingRead === null) this.warn('AID sent with no Read command pending');
    this.sendFields(this.pendingRead ?? Command.READ_MDT_FIELDS, aid, Opcode.PUT_GET);
    this.pendingRead = null;
    this.screen.keyboardLocked = true;
  }

  private sendFields(read: number, aid: number, opcode: number): void {
    const s = this.screen;
    const { row, col } = s.rowCol(s.cursor);
    const out: number[] = [row, col, aid];
    if (!AIDS_WITHOUT_DATA.has(aid)) {
      if (read === Command.READ_INPUT_FIELDS) {
        if (s.fields.some((f) => f.ffw & FFW.MDT)) {
          for (const f of s.fields) {
            if ((f.ffw & FFW.BYPASS) === 0) out.push(...this.fieldData(f));
          }
        }
      } else {
        const keepNulls = read === Command.READ_MDT_FIELDS_ALT;
        for (const f of s.fields) {
          if ((f.ffw & FFW.MDT) === 0) continue;
          const pos = s.rowCol(f.start);
          let bytes = this.fieldData(f);
          if (!keepNulls) {
            let end = bytes.length;
            while (end > 0 && bytes[end - 1] === 0x00) end--;
            bytes = bytes.slice(0, end).map((b) => (b === 0x00 ? 0x40 : b));
          }
          out.push(Order.SBA, pos.row, pos.col, ...bytes);
        }
      }
    }
    this.opts.sendRecord(buildRecord(opcode, out));
  }

  sendSystemRequest(): void {
    this.opts.sendRecord(buildRecord(Opcode.NO_OP, [], HeaderFlag.SRQ));
  }

  sendAttention(): void {
    this.opts.sendRecord(buildRecord(Opcode.NO_OP, [], HeaderFlag.ATN));
  }

  /** The Reset key: leave error state and restore the error line. */
  reset(): void {
    const s = this.screen;
    if (s.error) {
      s.buffer.set(s.error.saved, s.address(s.error.row, 1));
      s.error = null;
      s.keyboardLocked = false;
    }
    s.alarm = false;
  }

  private sendQueryReply(): void {
    const cp = this.opts.codepage;
    // "IBM-3179-2" -> device "3179", model "2"; "IBM-3477-FC" -> "3477", "FC".
    const [, device = '3179', model = '2'] = this.opts.terminalType.split('-');
    const r = new Array<number>(61).fill(0);
    r[0] = 0x00; r[1] = 0x00; // cursor row/col
    r[2] = Aid.INBOUND_WSF;
    r[3] = 0x00; r[4] = 58; // length of reply from here on
    r[5] = 0xd9; r[6] = 0x70; // class, type: query
    r[7] = 0x80; // flags: query reply
    r[8] = 0x06; r[9] = 0x00; // controller hardware class: 5250 emulator
    r[10] = 0x01; r[11] = 0x01; r[12] = 0x00; // controller code level V1R1M0
    // 13..28 reserved
    r[29] = 0x01; // display emulation
    cp.encode(device.padEnd(4).slice(0, 4)).forEach((b, k) => { r[30 + k] = b; });
    cp.encode(model.padStart(3, '0').slice(-3)).forEach((b, k) => { r[34 + k] = b; });
    r[37] = 0x02; // standard keyboard
    r[40] = 0x00; r[41] = 0x61; r[42] = 0x50; r[43] = 0x00; // display serial number
    r[44] = 0x01; r[45] = 0x00; // max input fields: 256
    r[49] = 0x01; // controller/display capability
    r[50] = 0x10;
    this.opts.sendRecord(buildRecord(Opcode.NO_OP, r));
  }

  /** Reply to Save Screen with a data stream that recreates the display. */
  private sendSaveScreen(): void {
    const s = this.screen;
    const out: number[] = [ESC, Command.RESTORE_SCREEN];
    if (s.rows === 27) out.push(ESC, Command.CLEAR_UNIT_ALTERNATE, 0x00);
    else out.push(ESC, Command.CLEAR_UNIT);
    out.push(ESC, Command.WRITE_TO_DISPLAY, 0x00, s.keyboardLocked ? 0x00 : 0x08);
    out.push(Order.SBA, 1, 1);
    const fieldsByAttr = new Map(s.fields.map((f) => [(f.start - 1 + s.size) % s.size, f]));
    for (let addr = 0; addr < s.size; addr++) {
      const f = fieldsByAttr.get(addr);
      const b = s.buffer[addr]!;
      if (f) {
        out.push(Order.SF, f.ffw >> 8, f.ffw & 0xff);
        for (const w of f.fcws) out.push(w >> 8, w & 0xff);
        out.push(f.attr, f.length >> 8, f.length & 0xff);
      } else if (b === 0x00 || isAttributeByte(b) || b >= 0x40) {
        out.push(b);
      } else {
        out.push(0x40); // control byte: would be misread as an order
      }
    }
    const { row, col } = s.rowCol(s.cursor);
    out.push(Order.IC, row, col);
    this.opts.sendRecord(buildRecord(Opcode.SAVE_SCREEN, out));
  }

  private warn(message: string): void {
    this.opts.onWarning?.(message);
  }
}
