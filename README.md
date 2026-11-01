<p align="center">
  <img src="docs/brand/veneer-logo-900.png" alt="Veneer" width="560">
</p>

# Veneer

Veneer renders IBM i 5250 green-screen applications as modern web pages without
changing host code.

**Where it runs:** on the IBM i itself, installed in the IFS and run in PASE as a service
(Service Commander or `SBMJOB`), or off the IBM i on any machine with Node.js 20.12 or
later: Linux with systemd, Docker, or a developer's PC. Either way it reaches the IBM i
over telnet; no libraries or programs are added to QSYS. See [deploy/README.md](deploy/README.md).

**Security:** Veneer can be secured end to end, on or off the IBM i. It connects to the
IBM i over TLS with the certificate checked, serves browsers over HTTPS, runs as a
low-authority service user, and locks the designer and admin page behind tokens.
[Securing Veneer](deploy/README.md#securing-veneer) is the checklist for a production
install.

## Packages

| Package | Status | Purpose |
| --- | --- | --- |
| `packages/tn5250` | Milestone 1 | Pure TypeScript TN5250 client: Telnet/TLS, 5250 data stream, screen model |
| `packages/server` | Milestone 2 | Session server: one host session per browser tab over WebSocket |
| `packages/client` | Milestone 3 | Browser client: React UI with auto-transform rules and the designer |
| `packages/screens` | Milestone 4 | Screen definitions: identification, customizations, validation |

## Development

```sh
npm install
npm test              # unit tests (node:test, runs TypeScript directly)
npm run build         # compile to dist/ for deployment
cp .env.example .env  # then set VENEER_HOST etc.
npm run cli           # interactive session against your IBM i
npm run demo          # fake IBM i + server + client on http://127.0.0.1:8080 (after npm run build)
                      # VENEER_DEMO_DELAY_MS=700 npm run demo simulates a slow host
npm run dev           # session server against your IBM i, restarts on change
npm run dev:client    # Vite dev server on :5173 with hot reload; proxies /ws to :8080
npm run package       # release/veneer-<version>.tar.gz for deployment, plus -src.tar.gz (the source)
```

**HTTPS and TLS:** with the defaults, Veneer talks to the IBM i over TLS on port 992 and
serves plain HTTP on 127.0.0.1. To serve HTTPS locally too, make a `localhost` certificate
with mkcert and set `VENEER_HTTPS_CERT`/`VENEER_HTTPS_KEY` in `.env`. [TLS and HTTPS](deploy/README.md#tls-and-https)
has the steps, and covers trusting an IBM i's own certificate.

**Deploying:** `npm run package` builds a self-contained archive that runs on any machine with
Node.js 20.12 or later, with no `npm install` and no internet access. [deploy/README.md](deploy/README.md)
covers installing it as a service on IBM i (Service Commander, or `SBMJOB` started at IPL)
and on Linux (systemd), plus upgrades, rollback and log files. To run it in Docker instead,
`docker compose up --build` (see [Docker](deploy/README.md#docker)).

In the CLI, `3=QSECOFR` stages a value for input field 3, and `enter`, `f3`, `pgdn`, etc.
send it. `VENEER_TRACE=traces/name.jsonl npm run cli` records every raw 5250 record
for building test fixtures. Traces contain everything typed, including passwords,
and `traces/` is git-ignored.

## Session server

Each browser WebSocket at `/ws` gets its own TN5250 session to the IBM i set in
`.env`. The browser cannot choose the host. Messages are JSON (see
`packages/server/src/protocol.ts`):

1. The client sends `{"type":"hello"}`, or `{"type":"hello","resumeToken":"..."}` after a reload.
2. The server replies with `hello` (session id + resume token), `status`, and then a `screen` each time the display changes.
3. The client sends `submit` (`aid`, changed `fields` by `"row:col"` id, optional `cursor`), `reset`, `sysreq`, `attn` or `disconnect`.

If a socket drops, its host session stays alive for `VENEER_RESUME_GRACE_SECONDS`
so a page reload can reattach. Sessions with no input for `VENEER_IDLE_TIMEOUT_MINUTES`
are ended. The server listens on 127.0.0.1 by default. Before exposing it on a
network, set `VENEER_HTTPS_CERT`/`VENEER_HTTPS_KEY` so sign-on passwords are encrypted.
By default, IBM i names the devices (QPADEVxxxx). Set `VENEER_DEVNAME_PREFIX=VENEER` to
get VENEER001, VENEER002, … instead, so Veneer jobs are easy to spot in WRKACTJOB. Names
are reused when sessions end, and the number width fills the 10-character limit (up to
3 digits). If a name is already in use, for example by a job left over from before a
restart or by another emulator, IBM i first checks that the session holding it is still
alive, then asks for another name. Veneer offers the next free one (up to three more) and
skips the busy name for 10 minutes. The log records `device name in use` and the
`device assigned` to each session.

### Admin page

`/admin` shows who is connected and lets an operator fix stuck sessions without
restarting the server:

- **Active sessions**, refreshed every two seconds: the IBM i user (read from the sign-on
  screen once the host accepts it), device name, browser address, when it connected, last
  activity, and whether a browser is attached or the session is waiting for a page reload.
- **End** closes the host connection, which ends the IBM i job and frees the device. The
  user's browser shows that an administrator ended the session. Each end is logged.
- **Recent warnings and errors** (the last 200, kept in memory whatever `VENEER_LOG_LEVEL`
  is) and **server** facts: version, uptime, the IBM i host and whether TLS is on.

Access works like the designer but is separate from it. `VENEER_ADMIN=local` opens the
page to browsers on the server's own machine (`npm run dev` and `npm run demo` set it);
everyone else needs `VENEER_ADMIN_TOKEN`, which the page asks for once per tab. The
designer token never opens the admin page, and the two tokens must differ.

## Auto-transform

The client renders each screen through a rule pipeline (`packages/client/src/transform`).
Every item keeps its 5250 row and column, so any screen renders faithfully. Recognized
patterns are swapped for widgets:

| Pattern | Becomes |
| --- | --- |
| Row 1 title and identifiers | Page header |
| `F3=Exit  F12=Cancel` legend | Button bar (keyboard F-keys still work; Shift+F1–F12 = F13–F24) |
| Message line / error line | Info or error banner (Esc = Reset) |
| Subfile above `More...` / `Bottom` | Table; mouse wheel and PgUp/PgDn page it |
| `2=Change  4=Delete` legend | Dropdown in the option column |
| ` 1. User tasks` menu lines | Links that enter the option |
| `===>` command line | Command input |
| `User . . . . :` dot leaders | Clean labels |
| Bordered pop-up window: the IBM i `.....` / `:` border, or any WDWBORDER characters or reverse-image border | Modal card over the dimmed screen; its F-keys and messages take over |

Rules run in order, and each one claims the cells it renders. Rules work on a region: the
whole screen, or the interior of the active pop-up window. Per-screen customizations
can later be added as extra rules. **Classic view** shows the untransformed screen.

## Exporting lists

Any screen with a list (a subfile) has an **Export** button in the key bar: **Excel (.xlsx)**
or **CSV**. Veneer pages up to the top of the list, then down to the bottom collecting every
row, then back to the page you were on. The option column is left out. In the Excel file,
numbers are numbers (`1,234.50-` becomes -1234.5), and codes with leading zeros such as
`00123` stay text. A progress window shows the pages read; **Cancel** (or Esc) stops and
returns you to your page. The Excel writer is built in, with no extra dependency.

## Type-ahead

As on a 5250, keys typed while the host is busy are not lost. They are queued (the header
shows "N typed ahead") and replayed into the next screen, starting at the host's cursor.
Full fields advance to the next field, and an AID key in the queue (Enter, F-keys, PgUp/PgDn)
submits; any keys after it wait for the following screen. A host error discards the queue.

## Help

The **Help** button at the end of the key bar presses the 5250 Help key for the field you
are in. F1 is not used: applications may give it their own meaning, so it goes to the host
as F1. Veneer reads the help the host shows, a pop-up window or a full screen, and shows its
text in a popover next to the field, while your screen stays as it was. **More** (or Page
Down) shows the next page of long help. Closing the popover (×, or Esc) closes the help on
the host (F12, then F3 if needed), and what you had typed is still there. If the host has no
help for the screen, its message shows as usual. In the classic view, Help shows the host's
help screens as they are.

## Several sessions and System Request

Each browser tab is its own session, and a reload resumes the tab's session. **System ▸
New session** in the header opens another one in a new tab. The **System** menu also sends
**System Request**, **Attention**, and **Transfer to secondary job**: SysReq, then option 1 on
the System Request line or menu, once it appears (other screens the host shows first, such
as Display Program Messages, are passed over).

## Field handling

The browser applies the same field rules as a 5250 terminal:

- **Numeric fields** right-align. Numeric-only fields accept digits, signs, `.` and `,`,
  and IBM i aligns the decimals using the job's decimal format. Signed numeric fields
  accept only digits and a sign, as on a terminal: the decimal point is implied by the
  field, so type `1250` for 12.50 (IBM i rejects a record with a `.` in a signed field).
  Digits-only fields accept only digits.
- **Negative numbers**: type `-` before or after the digits, or use keypad **−** (Field−).
  Keypad **+** (Field+) clears the sign. Both move to the next field. The value is sent
  as a 5250 does: right-adjusted, with the sign in the zone of the last digit.
- **Auto-enter** fields submit Enter as soon as they're full.
- **Mandatory entry** and **mandatory fill** fields are checked before Enter. A notice
  explains the problem, and the cursor goes back to the field.
- Upper-case (monocase) fields convert as you type. A full field advances to the next one.

## Screen customizations and the designer

Auto-transform handles every screen. For the screens people use most, a **screen
definition** goes further. Each definition is one JSON file in `screens/` (or
`VENEER_SCREENS_DIR`), so customizations are reviewed and versioned in git like code.

```json
{
  "id": "order-entry",
  "name": "Order entry",
  "match": { "screenIds": ["04e026716dd801"], "text": [] },
  "title": "New Order",
  "changes": [
    { "op": "text", "at": { "row": 6, "col": 4 }, "text": "Customer number" },
    { "op": "hide", "at": { "row": 7, "col": 30 } },
    { "op": "widget", "field": "7:22", "widget": { "type": "select", "options": [{ "value": "TX", "label": "Texas" }] } },
    { "op": "widget", "field": "10:22", "widget": { "type": "date", "format": "YYYYMMDD" } },
    { "op": "widget", "field": "11:22", "widget": { "type": "checkbox", "on": "Y", "off": "N" } },
    { "op": "button", "label": "Back to menu", "action": { "aid": "F12" } },
    { "op": "button", "label": "Customer in CRM", "action": { "url": "https://crm.example.com/customers/{6:22}" } },
    { "op": "style", "when": { "column": "Status", "equals": "MSGW" }, "role": "danger", "target": "row" }
  ]
}
```

- **Screen IDs:** every screen has an ID, a hash of what stays the same when the data
  changes. That's the screen size, the input-field layout from the display file, and the
  title. Dates, records, messages and the system name are left out, so an ID is the same
  on every page of a list and on development and production machines. A subfile's
  column of option fields counts once, whatever the number of records. A pop-up window is
  identified by its own title and fields, whatever screen it opens over. Recompiling a
  display file with a different field layout changes the ID.
- **Matching:** a definition applies when the screen's ID is one of its `screenIds`
  (if it lists any) and all its `text` rules match. Text rules are optional; use them to
  tell apart screens that share a layout and title, or screens with no input fields.
  List several IDs for variants of one screen, such as a list with no records (which
  has no option fields). If several definitions match, one with a screen ID wins, then
  the one with the most text rules.
- **Changes:**
  - `hide` hides the item at a position.
  - `text` replaces an item's text.
  - `role` restyles text (`emphasis`, `muted`, `danger`, …).
  - `widget` turns a field into a dropdown, checkbox or date picker. Values are
    converted to and from the host's format.
  - `button` adds an action button that presses a key, optionally filling fields first,
    or opens a web page in a new tab. In a `url`, `{6:22}` is replaced by the field starting
    at row 6, column 22 (including what the user has typed), or else the screen text there
    up to the next double space. `{6:22:10}` takes exactly 10 characters. Values are
    URL-encoded, and only `http://` and `https://` addresses with a fixed host name are
    allowed. In the designer, choose **Open URL** as the button's action. **Insert
    selected** adds the selected item's position, and a preview shows the address.
  - `style` restyles what matches a condition. `when` checks either a list column by its
    heading (`"column": "Status"`), with `target` set to `row` or `cell`, or the text or
    field at a position (`"at": { "row": 4, "col": 20 }`), with `target` set to `item`. The test is one
    of `equals`, `contains` or `matches` (a regular expression), all ignoring case, or
    `lessThan` or `greaterThan` for numbers. Numbers are read as screens show them
    (`12.50-`, `-12,50`, `1,234.50`). In the designer, the **Styles** section shows how
    many rows each rule matches on the current screen. A cell rule wins over a row rule.
  - `title` replaces the page title. The rest of the title row (program name, system
    name) appears in the page header. `hide`, `text`, `role` and `style` work on those items
    by their position on row 1. In the designer, click them in the header bar.
  - `move` draws an item somewhere else: `{ "op": "move", "at": { "row": 6, "col": 4 }, "to": { "row": 6, "col": 44 } }`.
    In the designer, drag any item (a table moves as a whole), or select it and use the arrow
    keys. Drag the corner handle of an HTML box to resize it. Moving only changes the layout:
    the host still sees fields where it put them, and Tab follows the new order.
  - `card` draws a framed panel, with an optional title on its border, around the cells
    from `from` to `to`: `{ "op": "card", "from": { "row": 5, "col": 2 }, "to": { "row": 9, "col": 60 }, "title": "Customer" }`.
    In the designer, select an item and click **Add card around this**, then drag the
    card's corner to resize it.
  - `tabs` splits rows into tabs, each a band of rows following the one before:
    `{ "op": "tabs", "tabs": [{ "title": "General", "from": 5, "to": 12 }, { "title": "Shipping", "from": 13, "to": 20 }] }`.
    One band shows at a time under a strip of tab titles, and the rows below move up.
    Fields on hidden tabs keep their values and are still sent. When the host puts the
    cursor on a hidden tab, or Veneer finds a problem in a field there, that tab opens.
    Cards and tabs use the positions where items are drawn, after moves. A card cannot be
    split between tabs. Tabs are not used while a pop-up window is shown. In the designer,
    select something on a row and click **Start a tab at row …** on the Page tab.
- **Designer:** a **Design** button appears when the designer is enabled. With
  `VENEER_DESIGNER=local`, browsers on the server's own machine use it without a token;
  `npm run dev` and `npm run demo` turn this on. For anyone else, set `VENEER_DESIGNER_TOKEN`,
  which the designer asks for once per tab. The two can be combined. The design panel has
  four tabs: **Site-wide** (CSS and JavaScript for every page), **Themes** (the look of every
  page: [Themes](#themes)), **Page** (this screen's
  customization: name, title, how it's recognised, buttons, CSS and JavaScript) and
  **Selected** (the item last clicked on the screen). Click any
  text, field or table to change it, and see the result immediately. New customizations
  are recognised by this screen's ID. To attach another variant, such as the empty list,
  open it, pick the existing customization in the panel, and click **Add this screen**.
  **Save** writes the JSON file, and every connected browser picks up the change at once.
  With neither setting, definitions are read-only.
- **Screen inventory:** the designer's **Screens** button lists every screen Veneer has
  shown, across all users, by screen ID: its title, input field count, how many times
  people opened it (paging and redraws don't count), when it was last seen, and which
  customization recognises it. Sort by most visited and tick **Not customized yet** to see
  which screens to customize next. Only the screen's shape is recorded, never what was on
  it. It is kept in `inventory.json` in `VENEER_DATA_DIR` (default `data/`, not in git).
- **Demo:** `npm run demo` includes a customized order-entry screen (main menu option 2),
  and serves the example components, ready to place from the designer.

### Themes

A theme is how every page looks, for everyone: a style sheet plus artwork (a logo and any
other images), made in the designer by whoever customizes the screens. One theme is in use at a
time; others stay saved, so you can prepare a new look and switch over when it's ready.

Themes are kept in the screens folder, so they go into git and from development to production
with the screen definitions:

```
screens/themes/acme/theme.css    the style sheet
screens/themes/acme/logo.svg     images; one named logo.* replaces the header logo and tab icon
screens/themes/active.json       {"theme": "acme"}: the theme in use
```

**Built-in themes:** **Default** (Veneer's own look, used until you pick another), **Compact**
(dense, for power users), **Flat** (accent-colored header, square corners, no shadows),
**Green screen** (the 5250 palette, always dark), **Soft** (larger, rounded, a floating key
bar) and **High contrast** (black on white, or white on black in dark mode, with strong borders
and focus rings). They come with Veneer and can't be changed, but each can be copied to start
your own. Their style sheets are in `packages/server/themes/` and make good examples.

**Make your company's theme:**

1. Open the designer and its **Themes** tab. Pick a theme to see the screen in it.
2. Under **New theme**, give your theme a name (letters, digits, `-` and `_`) and click
   **Make a copy**. It copies the theme you picked, style sheet and images.
3. Edit the **Style sheet**. The screen shows your changes as you type, and **Undo** and
   **Redo** step through them. Most themes only set CSS variables: open **CSS variables** and
   click **Insert** to add one to the `:root` rule with an example value, then change the value.
4. Under **Artwork**, add your logo (`logo.svg` or `logo.png`) and any other images: PNG, SVG,
   JPEG, WebP or GIF, up to 1 MB each. Use an image in the style sheet by its name, such as
   `background: url(banner.png)`.
5. Click **Save theme**, then **Use for everyone**. Every user's page switches to it from their
   next screen, without reloading. Host sessions aren't affected.

A short theme for a company in red:

```css
:root {
  --brand-accent: #c8102e;
  --header-bg: #7a0019;
  --header-text: #ffffff;
  --header-muted: #f3c6cd;
  --header-border: transparent;
  --radius: 4px;
}
@media (prefers-color-scheme: dark) {
  :root { --header-bg: #3d000c; }
}
```

A theme's style sheet is loaded after Veneer's own styles and before `global.css` and screen
CSS, so those can still adjust it. It can set its own dark-mode values with
`@media (prefers-color-scheme: dark)`, or be always light or always dark (Green screen sets
`color-scheme: dark`). Anything beyond the variables is ordinary CSS; to beat one of Veneer's
own rules, prefix your selector with `:root`, as the built-in themes do. Scripts and components
can read the theme in use from `<html data-theme="acme">`. Screen customizations are the same
in every theme.

**CSS variables:**

| Variable | Sets | Example |
| --- | --- | --- |
| `--brand-accent` | Accent color: buttons, links, focus and highlights | `#c8102e` |
| `--brand-accent-dark` | Accent color in dark mode (default: a lighter --brand-accent) | `#ff6b81` |
| `--bg` | Page background | `#f4f5f7` |
| `--surface` | The screen and panels | `#ffffff` |
| `--surface-2` | Raised and hovered areas, list stripes | `#f8f9fb` |
| `--border` | Borders and dividers | `#e2e5ea` |
| `--text` | Text | `#1d232b` |
| `--text-strong` | Headings and emphasis | `#0b1017` |
| `--text-muted` | Labels and secondary text | `#5c6673` |
| `--header-bg` | Page header background | `#0b3d91` |
| `--header-text` | Page header text | `#ffffff` |
| `--header-muted` | Page header secondary text | `#c9d6ee` |
| `--header-border` | Line under the page header | `transparent` |
| `--accent-2` | Second accent (designer highlights, accent2 role) | `#a1349b` |
| `--danger` | Errors and the danger role | `#c62828` |
| `--warning` | Warnings and the warning role | `#a15c00` |
| `--radius-small` | Corners of buttons and fields | `6px` |
| `--radius` | Corners of panels and menus | `8px` |
| `--radius-large` | Corners of the screen | `12px` |
| `--shadow` | Shadow under the screen and dialogs | `none` |
| `--rh` | Height of a screen row (spacing) | `1.9em` |
| `--cw` | Width of a screen column | `0.64em` |
| `--font` | Text font | `"Segoe UI", system-ui, sans-serif` |
| `--mono` | Fixed-width font (classic view, code) | `Consolas, monospace` |

Rename and delete themes from the Themes tab (the theme in use can't be deleted: use another
for everyone first). Editing themes needs the designer token, like the rest of the designer.

**Upgrading:** before themes, the designer's Site-wide tab had a **Style** section, saved as
`global.style.json`. The first time a newer Veneer starts, it turns a saved style into a theme
named `site` (the chosen look's style sheet with the chosen accent, corners, density and font),
and uses it for everyone, so nothing changes for users. The old file is left in place and no
longer read; delete it when you like.

**Security:** a theme's CSS is trusted like `global.css`, since designers can already write
site-wide CSS and JavaScript. Uploaded images are checked on the server: by content, not just
by name, up to 1 MB, with safe file names. Theme images are served so an SVG opened directly
can't run script.

### Custom HTML, CSS and JavaScript

Designers can add their own code where the built-in changes aren't enough:

| | Site-wide (in the screens folder) | Per page (in its definition) | Per HTML box |
| --- | --- | --- | --- |
| HTML | | `html` changes: a box at a row and column, `width` × `height` cells | `html` |
| CSS | `global.css`, on every page | `css`, while the screen is shown | `css`, scoped to the box |
| JavaScript | `global.js` on **page load** (once); `global-screen.js` on **every screen** | `scripts.load` when the screen **opens**; `scripts.show` on **every redraw** | `script`, on every redraw |

In the designer, the **Site-wide** and **Page** tabs each have a CSS box and an **Event**
picker over one JavaScript box (events that have a script are marked ●). Add HTML from the
Page tab's **HTML** section, or click an empty spot on the screen. Click an HTML box to edit
its HTML, CSS and JavaScript on the **Selected** tab.

```json
{ "op": "html", "at": { "row": 5, "col": 46 }, "width": 28, "height": 2,
  "html": "<button class=\"help\">Need help?</button>",
  "css": "button { font-weight: 600; }",
  "script": "element.querySelector('.help').onclick = () => veneer.press('F1');" }
```

A box's CSS is nested inside the box: plain declarations style the box, and rules like
`button { … }` style what's in it. "Opens" means arriving from a different screen;
"redraw" includes paging and error messages on the same screen.

Every script is the body of `function (veneer, screen, element)`. `screen` describes the
screen showing (`{ id, definition, rows, cols, lines, fields }`). `element` is the page
element holding the screen, or the box for an HTML box's script. Functions a script declares
(`function doMessage() { … }`) can be called from the HTML, as in `onclick="doMessage()"`, while
the script is active. A script may return a
function to undo what it set up: an "opens" script's runs when the screen closes, the
others' before the next redraw. `veneer` (also `window.veneer`) offers:

- `veneer.screen`: the screen showing.
- `veneer.on('screen', (screen, element) => …)`: called after each screen is drawn. It
  returns a function that unsubscribes.
- `veneer.getField('6:53')`, `veneer.setField('6:53', 'X')`: read a field, or type into it.
- `veneer.press('F3')`, `veneer.press('Enter', { '6:53': 'X' })`: press a key, optionally
  filling fields first.

The app root carries `data-screen="<definition id>"`, so site CSS can target one screen.
Scripts pause while designing; **Test script** runs the draft once. A changed page-load
script runs after a page reload.

**Custom code runs with the page's full rights**, like Veneer's own code: it can read
everything users type, passwords included. Give designer access only to people you'd
trust to change the site's code, and review definitions in git like code.

### Custom components

For things the designer can't build, such as a chart, a signature pad or a lookup in another
system, developers write **components**: ES modules in the server's components folder
(`VENEER_COMPONENTS_DIR`, default `components/` in the repo), one `name.js` per component.
Veneer serves them at `/components/` and lists them at `/api/components`. Nothing in the
designer can add or change them: designers place installed components and set their options.
A component can import other files from the same folder. Browsers load a new version after
a page reload; the server lists new files after a restart.

A component draws in a box over the screen, or in place of an input field:

```json
{ "op": "component", "name": "bar-chart", "at": { "row": 17, "col": 2 }, "width": 76, "height": 4,
  "options": { "column": "Amount", "label": "Order" } }
{ "op": "component", "name": "star-rating", "at": { "row": 19, "col": 24 }, "width": 5, "height": 1,
  "field": "19:24", "options": { "max": 5 } }
```

In the designer, add one from the Page tab's **Components** section, or select a field and
choose **Show as: Component**. Select it to pick another component, edit its options (JSON),
move it or resize it.

The module exports `mount(element, ctx)`, and optionally a `label`. `mount` draws into
`element` and may return `{ update(ctx), unmount() }` (or just a cleanup function).
`update` is called when the screen is redrawn or the bound field's value changes; keep the
newest `ctx` it is given. `ctx` has:

- `options`: the change's options.
- `screen`: `{ id, definition, rows, cols, lines, fields }`, as for scripts.
- `tables`: the lists on the screen, in screen order, including lists the definition hides
  (so a component can take a list's place). Each is
  `{ row, col, columns, rows, records, options, more, hidden }`: `columns` are the headings,
  `rows` each row's cells as text, `options` the legend's options (`[{ value: "5", label:
  "Display" }]`), `more` whether paging down shows more, and `hidden` whether the definition
  hides it. `records` are the same rows with more detail: `{ row, cells, fields, option, role,
  roles }`, where `fields` holds each cell's input field id (or `null`), `option` is the
  row's option field id (or `null`), `role` the role a style rule gave the row, and `roles`
  each cell's role. To pick an option on a row, `press('Enter', { [record.option]: '5' })`.
- For a field: `field` (`{ id, length }`), `value` and `setValue(text)`, which types into it.
- `getField(id)`, `setField(id, text)` and `press(key, fields?)`, which go through the
  same path as the user typing and pressing keys.
- `design`: true in the designer, where typing and keys do nothing.

```js
export const label = 'Hello';
export function mount(element, ctx) {
  element.textContent = `Hello from ${ctx.screen.id}`;
  return { update: (next) => { element.textContent = `Hello from ${next.screen.id}`; } };
}
```

A component that can't be loaded, or throws, is reported in the browser console, and a field
it replaced gets its normal input back; the designer shows a note in its box. Components run
with the page's full rights, like designers' scripts, so only install code you have reviewed.

### Ready-made components

Veneer comes with four components, in `examples/components/` of the release (in the
repo: `packages/server/dev/components/`, which `npm run demo` uses):

| Component | Shows |
| --- | --- |
| `map.js` | An address from the screen on a map ([below](#map-component)) |
| `cards.js` | A list as cards, one per row, with the list's options as buttons ([below](#card-view-component)) |
| `bar-chart.js` | A column of a list as a bar chart |
| `star-rating.js` | A one-digit field as stars |

To install one, copy it into the server's components folder (`VENEER_COMPONENTS_DIR`) and
restart Veneer. On a server install, keep components outside the program directory, next
to the configuration, so upgrades keep them:

| Install | Components folder | Set in `veneer.env` |
| --- | --- | --- |
| IBM i | `/QOpenSys/etc/veneer/components` | `VENEER_COMPONENTS_DIR=/QOpenSys/etc/veneer/components` |
| Linux | `/etc/veneer/components` | `VENEER_COMPONENTS_DIR=/etc/veneer/components` |
| Docker | `/app/components`: mount a folder there, `-v ./components:/app/components:ro` | nothing |
| Development | `components/` in the repo (git-ignored) | nothing |

```sh
# IBM i (QSH or SSH)
mkdir -p /QOpenSys/etc/veneer/components
cp /QOpenSys/opt/veneer/current/examples/components/map.js /QOpenSys/etc/veneer/components/
```

The service user needs to read the folder, not write it. An upgrade doesn't change your
copy; to get a newer version of a component, copy it again from `examples/components/`.

### Map component

`map.js` shows an address from the screen on a map, with an **Open in maps** link to the
full map in a new tab. Use it on any screen that shows an address: customers, ship-to
addresses, warehouses, service calls. Several maps can share a screen, such as billing and
shipping side by side. The demo's option 3, **Customer addresses**, has an example.

**Add a map to one of your screens:**

1. **Install** `map.js` (above).
2. **Find the address on the screen.** Write down the row and column where each part
   starts (rows and columns count from 1, as in screen definitions): for example, the street
   at row 8, column 4, the city at row 9, column 4, and the state and ZIP code at row 10,
   columns 4 and 8.
3. **Place the map.** In the designer, open the screen, then the Page tab's **Components**
   section, and add **Map**. Drag it to an empty area and drag its corner to size it; about
   35 columns by 8 rows works well.
4. **Set its options** (the JSON box on the Selected tab):
   ```json
   { "address": ["8:4", "9:4", "{10:4} {10:8}", "USA"], "title": "Ship to" }
   ```
5. In the designer the map stays blank until you click **Show map**, so the addresses of
   the records you design with aren't sent to the map provider by accident. Click it to
   check the map, then **Save**. Users see the map on the next screen.

**Options:**

| Option | |
| --- | --- |
| `address` | Required. The parts of the address, joined with commas. `"8:4"` is the field starting at row 8, column 4 (what the user has typed included), or else the screen text there up to the next double space. `"8:4:30"` takes exactly 30 characters. A part can mix positions and text, like `"{10:4} {10:8}"` (state and ZIP code on one line) or `"USA"` |
| `title` | A caption above the map |
| `provider` | `openstreetmap` (the default) or `google` |
| `apiKey` | A Google Maps Embed API key, for `google`. Without one, Google's keyless embed is used |
| `zoom` | 1 (the world) to 19 (a building). Default 15 (streets) |
| `geocoder` | For `openstreetmap`: a Nominatim search address (`https://…`) to use instead of `nominatim.openstreetmap.org` |
| `link` | `false` hides the **Open in maps** link |

Fixed text such as `"USA"` never makes a map on its own: when every position in the address
is blank (a new record, say), the map says there's no address. The map follows the screen:
paging to the next record, or editing an address field, redraws it a moment after the
address stops changing.

**Choosing a provider:**

- **OpenStreetMap** needs no key or account. It first finds the address's coordinates
  with OpenStreetMap's Nominatim service, then shows the map. Nominatim is free for light
  use: about one lookup a second for the whole site, and each address is looked up once per
  page. For heavier use, run your own Nominatim (or a compatible service) and point
  `geocoder` at it, or use Google.
- **Google Maps** places the address itself, so there's no lookup step. Without `apiKey`,
  Veneer uses Google's keyless embed, which works but is not an official API. For production
  use, create a Maps Embed API key in the Google Cloud console, restrict it to your Veneer
  site's address, and set `apiKey`.

**Privacy:** the map provider receives every address shown in a map, and the user's
browser connects to it directly. Check that this is acceptable for your data before turning
maps on. Only the address is sent, never other fields from the screen.

**Network and firewalls:** users' browsers (not the Veneer server) must reach the provider:
`www.openstreetmap.org`, `tile.openstreetmap.org` and the geocoder for OpenStreetMap, or
`www.google.com` and `maps.google.com` for Google. If your site adds a Content-Security-Policy
in front of Veneer, allow those hosts in `frame-src`, and the geocoder in `connect-src`.

### Card view component

`cards.js` shows a list (a subfile) as cards, one per row: a title, a subtitle and a few
facts, with the list's options (`2=Change  5=Display`) as buttons. Lists of people, customers
or items with a few key facts each read better this way than as rows. The demo's option 4,
**Customer contacts**, has an example.

**Show one of your lists as cards:**

1. **Install** `cards.js` ([above](#ready-made-components)).
2. **Hide the list.** In the designer, open the screen, select the list and tick **Hide**.
   Also hide the option legend above it (each option, such as `2=Change`, is its own item)
   and the **More** / **Bottom** marker under it, and the "Type options, press Enter." line if
   you like. A hidden list isn't drawn, but its option fields are still on the screen,
   and the cards type into them.
3. **Place the cards.** In the Page tab's **Components** section, add **Cards**, and drag
   and size it over the space the list and its legend used. Give it room: cards wrap into
   as many columns as fit, and scroll if there are more rows than fit.
4. **Set its options** (the JSON box on the Selected tab), naming columns by their headings:
   ```json
   { "title": "Name", "subtitle": "Company", "fields": ["City", "Phone", "Status"], "default": "5" }
   ```
5. **Save.** Users see cards on the next screen.

**Options:**

| Option | |
| --- | --- |
| `title` | The column for each card's title. Default: the first column after the option column |
| `subtitle` | A column shown under the title |
| `fields` | The columns shown on each card, in order, as "heading value". Default: every other column |
| `actions` | Which options to offer as buttons, in order, by value: `["5", "2"]`. Default: all the legend's options. `[]` for none |
| `default` | The option a click on a card, or Enter on it, runs: `"5"`. Default: none, so only the buttons do something |
| `pager` | `false` hides the **Previous** and **Next** buttons |
| `width` | The narrowest a card gets, in pixels (120 to 600). Default 220 |
| `empty` | What to say when the list has no rows. Default "Nothing to show" |

Headings are matched ignoring case. With several lists on a screen, the cards show the first
one that has every column the options name (or the first list, if they name none).

**What the user can do:** a button types its option into that row's option field and
presses Enter, exactly as if the user had typed it, so the program sees nothing new.
**Previous** and **Next** press Page Up and Page Down; **Next** shows only when the host says
there is more. The keyboard works too: Tab reaches the cards, the arrow keys, Home and End
move between them, and Enter runs `default`. After a press the buttons wait for the next
screen, so a double click sends one key.

**Colors:** [style rules](#screen-customizations-and-the-designer) carry over. A rule that
colors a whole row colors that card's edge (a `danger` row gives a red card); a rule that
colors one cell colors that fact; `muted` rows are faded.

A list without an option legend still shows as cards, without buttons. In the designer the
cards are drawn, but clicking them does nothing.

## Branding

Server settings put a company's name, logo and color on every page, the admin page included:

| Setting | |
| --- | --- |
| `VENEER_BRAND_NAME` | Product name: the header when a screen has no title, and the browser tab |
| `VENEER_BRAND_LOGO` | Path to a PNG, SVG, JPEG, WebP or GIF (up to 1 MB), shown 32px high in the header and used as the tab icon |
| `VENEER_BRAND_ACCENT` | Accent color, as hex (`#0a7f5a`): buttons, links, focus rings, highlights |
| `VENEER_BRAND_ACCENT_DARK` | Optional accent for dark mode; without it, dark mode uses a lighter shade of the accent |

Light and dark mode still follow the browser. Pick an accent that white text reads well on,
since the main buttons use it as their background. Restart the server after changing these.

A screen definition can use its own accent, for instance a color per application area, by
setting the same variables in its CSS: `:root { --brand-accent: #8a3ffc; }` (and
`--brand-accent-dark` if needed). `global.css` can do the same for every page. A
[theme](#themes) that sets an accent or has a logo overrides `VENEER_BRAND_ACCENT` and
`VENEER_BRAND_LOGO`; where it sets neither, these settings still apply.

## License

[MIT](LICENSE) © 2026 Daniel Long
