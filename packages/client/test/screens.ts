// Realistic screens, built as host data streams and run through the real terminal.

import { type ScreenSnapshot } from '@veneer/terminal';
import { Attr, HostStream, Terminal, buildRecord, getCodepage, snapshot } from '@veneer/tn5250';

const cp = getCodepage(37);
const { WHITE, BLUE, NONDISPLAY } = Attr;

function render(build: (s: HostStream) => HostStream, error?: string): ScreenSnapshot {
  const t = new Terminal({ codepage: cp, terminalType: 'IBM-3179-2', sendRecord: () => {} });
  t.processRecord(buildRecord(0x03, build(new HostStream().clear().write()).readMdt().build()));
  if (error) t.processRecord(buildRecord(0x03, new HostStream().errorMessage(error).build()));
  return snapshot(t.screen, cp);
}

export const titled = (title: string, error?: string) => render((s) => s.text(1, 36, title, WHITE), error);

export const signOn = () => render((s) => s
  .text(1, 36, 'Sign On', WHITE)
  .text(2, 48, 'System . . . . . :   PUB400')
  .text(6, 17, 'User  . . . . . . . . . . . . . .')
  .field(6, 53, 10, { ffw: 0x4020 })
  .text(7, 17, 'Password  . . . . . . . . . . . .')
  .field(7, 53, 10, { attr: NONDISPLAY })
  .text(24, 40, '(C) COPYRIGHT IBM CORP. 1980, 2024.'));

export const mainMenu = () => render((s) => s
  .text(1, 2, 'MAIN')
  .text(1, 33, 'IBM i Main Menu', WHITE)
  .text(1, 64, 'System:   PUB400')
  .text(3, 2, 'Select one of the following:')
  .text(5, 6, '1. User tasks')
  .text(6, 6, '2. Office tasks')
  .text(15, 5, '90. Sign off')
  .text(19, 2, 'Selection or command')
  .text(20, 2, '===>')
  .field(20, 7, 70)
  .text(22, 2, 'F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel   F13=Information Assistant', BLUE)
  .text(23, 2, 'F23=Set initial menu', BLUE));

export const workWithJobs = (marker = 'More...') => render((s) => s
  .text(1, 30, 'Work with Active Jobs', WHITE)
  .text(1, 72, 'PUB400')
  .text(7, 2, 'Type options, press Enter.', BLUE)
  .text(8, 3, '2=Change   3=Hold   4=End   5=Work with   6=Release', BLUE)
  .text(10, 2, 'Opt  Subsystem/Job  User        Type    CPU %  Function        Status', WHITE)
  .field(11, 3, 1).text(11, 7, 'QBATCH').text(11, 22, 'QSYS        SBS').text(11, 45, '.0').text(11, 66, 'DEQW')
  .field(12, 3, 1).text(12, 7, 'QINTER').text(12, 22, 'QSYS        SBS').text(12, 43, '12.5').text(12, 66, 'DEQW')
  .field(13, 3, 1).text(13, 9, 'QPADEV0001').text(13, 22, 'DLONG       INT').text(13, 45, '.1')
  .text(13, 50, 'CMD-WRKACTJOB').text(13, 66, 'RUN')
  .text(19, 73, marker)
  .text(20, 2, 'Parameters or command')
  .text(21, 2, '===>')
  .field(21, 7, 73)
  .text(22, 2, 'F3=Exit   F5=Refresh   F7=Find   F10=Restart statistics', BLUE)
  .text(23, 2, 'F11=Display elapsed data   F12=Cancel   F23=More options   F24=More keys', BLUE));

export interface WindowOptions {
  borderTitle?: string;
  /**
   * Border characters in DDS WDWBORDER CHAR order: top-left, top, top-right,
   * left, right, bottom-left, bottom, bottom-right. Default: the IBM i border.
   */
  border?: string;
  /** Border attribute; default blue. */
  borderAttr?: number;
}

/** The main menu with a prompt window over it, cursor in the window. */
export const promptWindow = (opts: WindowOptions = {}) => render((s) => {
  s.text(1, 2, 'MAIN').text(1, 33, 'IBM i Main Menu', WHITE)
    .text(3, 2, 'Select one of the following:')
    .text(5, 6, '1. User tasks').text(6, 6, '2. Office tasks')
    .text(19, 2, 'Selection or command').text(20, 2, '===>').field(20, 7, 70)
    .text(22, 2, 'F3=Exit   F4=Prompt   F12=Cancel', BLUE);
  const [tl, t, tr, l, r, bl, b, br] = [...(opts.border ?? '...:::.:')] as string[];
  const attr = opts.borderAttr ?? BLUE;
  const fill = opts.borderTitle ? `${t!.repeat(3)} ${opts.borderTitle} ${t!.repeat(33 - opts.borderTitle.length)}` : t!.repeat(38);
  s.text(7, 20, tl + fill + tr, attr);
  for (let row = 8; row <= 15; row++) s.text(row, 20, l!, attr).text(row, 59, r!, attr);
  s.text(16, 20, bl + b!.repeat(38) + br, attr);
  if (!opts.borderTitle) s.text(8, 30, 'Select Printer', WHITE);
  return s
    .text(10, 22, 'Type choices, press Enter.', BLUE)
    .text(12, 22, 'Printer . . . . :')
    .field(12, 41, 10, { ffw: 0x4020 })
    .text(13, 22, 'Copies  . . . . :')
    .field(13, 41, 3, { ffw: 0x4300 })
    .text(15, 22, 'F4=Prompt   F12=Cancel', BLUE)
    .cursor(12, 41);
});

/** A normal screen with dashed separator lines and a text table: no windows here. */
export const drawnLines = () => render((s) => s
  .text(1, 30, 'Item Availability', WHITE)
  .text(3, 2, '-'.repeat(78))
  .text(4, 2, 'Warehouse . . . :   CENTRAL')
  .text(5, 2, 'Updated . . . . :   2026-10-24')
  .text(6, 2, '-'.repeat(78))
  .text(8, 4, '+----------+----------+')
  .text(9, 4, '| Item     | Qty      |')
  .text(10, 4, '+----------+----------+')
  .text(11, 4, '| A100     | 5        |')
  .text(12, 4, '| B200     | 12       |')
  .text(13, 4, '+----------+----------+')
  .text(8, 40, '+-------+-------+')
  .text(9, 40, '| Dept  | Name  |')
  .text(10, 40, '|  10   | Sales |')
  .text(11, 40, '+---------------+')
  .text(15, 2, '='.repeat(40))
  .text(16, 2, '| Totals are estimates                 |')
  .text(17, 2, '='.repeat(40) + '==')
  .text(20, 2, ' '.repeat(78), Attr.GREEN_REVERSE)
  .text(21, 3, 'Option').field(21, 12, 2, { attr: 0x25 })
  .text(23, 2, ' '.repeat(78), Attr.GREEN_REVERSE)
  .text(24, 2, 'F3=Exit   F12=Cancel', BLUE));

/** An order entry screen exercising field rules. */
export const orderEntry = () => render((s) => s
  .text(1, 33, 'Order Entry', WHITE)
  .text(4, 3, 'Customer').field(4, 20, 6, { ffw: 0x4008 })       // mandatory enter
  .text(5, 3, 'State').field(5, 20, 2, { ffw: 0x4027 })           // monocase, mandatory fill
  .text(6, 3, 'Quantity').field(6, 20, 5, { ffw: 0x4706 })        // signed numeric, blank fill
  .text(7, 3, 'Item code').field(7, 20, 3, { ffw: 0x4580 }));      // digits only, auto-enter

/** The System Request line the host shows after SysReq. */
export const sysreqPrompt = () => render((s) => s
  .text(1, 33, 'IBM i Main Menu', WHITE)
  .field(24, 2, 78));

/** An order with a ship-via code, a quantity and four comment lines (the second one filled in). */
export const orderNotes = () => render((s) => s
  .text(1, 33, 'Order Notes', WHITE)
  .text(4, 3, 'Ship via').field(4, 20, 1, { ffw: 0x4020 })        // monocase
  .text(5, 3, 'Quantity').field(5, 20, 5, { ffw: 0x4700 })        // signed numeric
  .text(6, 3, 'Boxes').field(6, 20, 3, { ffw: 0x4300 })           // numeric only
  .text(8, 3, 'Comments')
  .field(8, 20, 20)
  .field(9, 20, 20, { value: 'FRAGILE' })
  .field(10, 20, 20)
  .field(11, 20, 20)
  .field(12, 40, 20)                                             // another column: not a line
  .text(24, 2, 'F3=Exit   F12=Cancel', BLUE));
