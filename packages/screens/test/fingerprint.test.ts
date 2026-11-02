import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Attr, HostStream, Terminal, buildRecord, getCodepage, snapshot } from '@veneer/tn5250';
import { fingerprint, matchScreen, screenId, type ScreenDefinition } from '../src/index.ts';

const cp = getCodepage(37);
const { WHITE, BLUE } = Attr;

function screen(build: (s: HostStream) => HostStream, then?: number[]) {
  const t = new Terminal({ codepage: cp, terminalType: 'IBM-3179-2', sendRecord: () => {} });
  t.processRecord(buildRecord(0x03, build(new HostStream().clear().write()).readMdt().build()));
  if (then) t.processRecord(buildRecord(0x03, then));
  return snapshot(t.screen, cp);
}

/** A Work with ... list: n records, each with an option field. */
function jobs(n: number, opts: { system?: string; time?: string; title?: string } = {}) {
  return screen((s) => {
    s.text(1, 30, opts.title ?? 'Work with Active Jobs', WHITE).text(1, 72, opts.system ?? 'PROD01')
      .text(3, 52, opts.time ?? '10/23/26  11:42:07')
      .text(10, 2, 'Opt  Job         User', WHITE);
    for (let i = 0; i < n; i++) s.field(11 + i, 3, 2).text(11 + i, 7, `JOB${i}`).text(11 + i, 19, 'QSYS');
    return s.text(20, 73, n > 5 ? 'More...' : 'Bottom').text(22, 2, '===>').field(22, 7, 73);
  });
}

test('the id ignores data: times, records, system name, messages', () => {
  const id = screenId(jobs(3));
  assert.equal(screenId(jobs(3, { time: '12/31/26  23:59:59' })), id);
  assert.equal(screenId(jobs(1)), id, 'one record');
  assert.equal(screenId(jobs(9)), id, 'a full page');
  assert.equal(screenId(jobs(3, { system: 'DEV01' })), id, 'development vs production');
  const withError = screen((s) => s, new HostStream().errorMessage('CPF0001 - Something went wrong.').build());
  assert.equal(screenId(withError), screenId(screen((s) => s)));
});

test('the id changes when the screen does', () => {
  const id = screenId(jobs(3));
  assert.notEqual(screenId(jobs(3, { title: 'Work with Spooled Files' })), id, 'title');
  assert.notEqual(screenId(screen((s) => s.text(1, 30, 'Work with Active Jobs', WHITE).field(22, 7, 72))), id, 'field layout');
  assert.notEqual(screenId(jobs(0)), id, 'an empty list has no option fields: a separate variant');
});

/** The same prompt window over a different screen, at a different place. */
function promptOver(background: string, top: number, left: number) {
  return screen((s) => {
    s.text(1, 33, background, WHITE).field(20, 7, 70);
    s.text(top, left, '.... Select Printer ' + '.'.repeat(20), BLUE);
    for (let r = top + 1; r <= top + 4; r++) s.text(r, left, ':', BLUE).fill(r, left + 2, 36).text(r, left + 39, ':', BLUE);
    s.text(top + 5, left, ':' + '.'.repeat(38) + ':', BLUE);
    return s.text(top + 2, left + 3, 'Printer').field(top + 2, left + 20, 10).cursor(top + 2, left + 20);
  });
}

test('a pop-up window has the same id over any screen and at any position', () => {
  const a = fingerprint(promptOver('IBM i Main Menu', 7, 18));
  const b = fingerprint(promptOver('Work with Spooled Files', 10, 25));
  assert.equal(a.title, 'Select Printer');
  assert.equal(a.fields, 1, 'only the window field counts');
  assert.equal(a.id, b.id);
});

test('matching by screen id beats text rules; ids list variants', () => {
  const snap = jobs(3);
  const byText: ScreenDefinition = { id: 'text', name: 'text', match: { text: [{ row: 1, col: 30, text: 'Work with Active Jobs' }] }, changes: [] };
  const byId: ScreenDefinition = { id: 'sid', name: 'sid', match: { screenIds: ['00000000000000', screenId(snap)], text: [] }, changes: [] };
  assert.equal(matchScreen(snap, [byText, byId])?.id, 'sid');
  assert.equal(matchScreen(jobs(0), [byId]), undefined, 'the empty variant needs its own id');
  assert.equal(matchScreen(jobs(0), [{ ...byId, match: { ...byId.match, screenIds: [...byId.match.screenIds!, screenId(jobs(0))] } }])?.id, 'sid');
});

test('ids are stable across versions', () => {
  // Saved definitions reference these ids. If this value changes, the fingerprint
  // algorithm changed and every saved customization would stop matching.
  assert.equal(screenId(jobs(3)), STABLE_ID);
});

const STABLE_ID = '041d16c4529775';

test('a 3270 screen never gets the id of the same-looking 5250 screen', () => {
  const ibmi = jobs(3);
  const mainframe = { ...ibmi, host: '3270' as const };
  assert.notEqual(screenId(mainframe), screenId(ibmi));
  assert.equal(screenId(ibmi), STABLE_ID, '5250 ids are unchanged');
  assert.equal(screenId({ ...jobs(1, { time: '12/31/26  23:59:59' }), host: '3270' }), screenId(mainframe), 'data is still ignored');
  assert.match(fingerprint(mainframe).source, /^3270\n24x80\n/);
});
