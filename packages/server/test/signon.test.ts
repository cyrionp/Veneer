import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ScreenSnapshot } from '@veneer/terminal';
import { Attr, HostStream, Terminal, buildRecord, getCodepage, snapshot } from '@veneer/tn5250';
import { displayName, signOnUserField, submittedUser } from '../src/signon.ts';

const cp = getCodepage(37);
function render(build: (s: HostStream) => HostStream): ScreenSnapshot {
  const t = new Terminal({ codepage: cp, terminalType: 'IBM-3179-2', sendRecord: () => {} });
  t.processRecord(buildRecord(0x03, build(new HostStream().clear().write()).readMdt().build()));
  return snapshot(t.screen, cp);
}

const ibm = render((s) => s
  .text(1, 36, 'Sign On')
  .text(3, 48, 'Display . . . . . :   QPADEV0007')
  .text(6, 17, 'User  . . . . . . . . . . . . . .').field(6, 53, 10)
  .text(7, 17, 'Password  . . . . . . . . . . . .').field(7, 53, 10, { attr: Attr.NONDISPLAY }));

// PUB400's own sign-on screen.
const pub400 = render((s) => s
  .text(1, 10, 'Welcome to PUB400.COM * your public IBM i server')
  .text(4, 48, 'Display name. . . :   LONGDMV01')
  .text(5, 2, 'Your user name:').field(5, 23, 10)
  .text(6, 2, 'Password (max. 128):').field(6, 23, 50, { attr: Attr.NONDISPLAY }));

test("reads the user field and display name on IBM's sign-on screen", () => {
  assert.equal(signOnUserField(ibm)?.id, '6:53');
  assert.equal(displayName(ibm), 'QPADEV0007');
  assert.equal(submittedUser(ibm, { '6:53': ' qsecofr ', '7:53': 'secret' }), 'QSECOFR');
});

test('reads a custom sign-on screen that labels the field "Your user name"', () => {
  assert.equal(signOnUserField(pub400)?.id, '5:23');
  assert.equal(displayName(pub400), 'LONGDMV01');
  assert.equal(submittedUser(pub400, { '5:23': 'longdm' }), 'LONGDM');
});

test('other screens, and values that are not user names, give nothing', () => {
  const menu = render((s) => s.text(1, 33, 'IBM i Main Menu').text(20, 2, 'User tasks').field(20, 20, 10));
  assert.equal(signOnUserField(menu), undefined, 'no password field');
  assert.equal(submittedUser(ibm, { '6:53': 'not a name' }), undefined);
});
