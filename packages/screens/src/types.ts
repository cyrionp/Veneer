// Screen definitions: how to recognise a screen, and what to change on it.
// Stored as one JSON file per screen, so they can be reviewed in git.

import type { AidName } from '@veneer/tn5250';

/** Semantic color roles (CUA conventions mapped from 5250 colors). */
export const ROLES = ['normal', 'emphasis', 'muted', 'danger', 'warning', 'accent', 'accent2'] as const;
export type Role = (typeof ROLES)[number];

/** A screen position: the first cell of the item being changed (1-based). */
export interface Target {
  row: number;
  col: number;
}

/** Text that must appear at a position for the screen to match. */
export interface TextMatch extends Target {
  text: string;
}

/**
 * How a definition recognises its screen: any of the screen ids (see
 * fingerprint.ts), and all of the text rules. At least one of the two is needed.
 */
export interface Match {
  /** Screen ids this definition applies to (variants such as an empty list). */
  screenIds?: string[];
  /** Screen size, when the definition only applies to 24x80 or 27x132. */
  rows?: number;
  cols?: number;
  /** Text that must also appear at fixed positions. */
  text: TextMatch[];
}

export const DATE_FORMATS = ['YYYYMMDD', 'MMDDYYYY', 'MMDDYY', 'DDMMYYYY', 'DDMMYY', 'YYMMDD', 'MM/DD/YYYY', 'MM/DD/YY', 'DD/MM/YYYY', 'YYYY-MM-DD'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export interface SelectOption {
  value: string;
  label: string;
}

export type Widget =
  | { type: 'select'; options: SelectOption[] }
  | { type: 'checkbox'; on: string; off: string }
  | { type: 'date'; format: DateFormat };

/** Press a key, optionally typing into fields first. */
export interface KeyAction {
  aid: AidName;
  /** Field values to type before pressing the key, by field id ("row:col"). */
  fields?: Record<string, string>;
}

/**
 * Open a web page in a new tab. `{row:col}` in the URL is replaced by the
 * field or screen text at that position, `{row:col:length}` by exactly that
 * many characters (see links.ts). Only http(s), with a fixed host.
 */
export interface UrlAction {
  url: string;
}

export type ButtonAction = KeyAction | UrlAction;

/**
 * What a style rule checks: each row's cell in a table column (by its
 * heading), or the text or field at a screen position. Exactly one test:
 * equals, contains and matches (a regular expression) ignore case; lessThan
 * and greaterThan read the text as a number. See styles.ts.
 */
export interface StyleCondition {
  column?: string;
  at?: Target;
  equals?: string;
  contains?: string;
  matches?: string;
  lessThan?: number;
  greaterThan?: number;
}

/** What a style rule restyles: a column condition's whole row or cell, or the item at `at`. */
export const STYLE_TARGETS = ['row', 'cell', 'item'] as const;
export type StyleTarget = (typeof STYLE_TARGETS)[number];

/** Settings for a component, as JSON. */
export type ComponentOptions = { [key: string]: unknown };

/** One tab: a band of whole screen rows, `from` to `to` inclusive. */
export interface TabBand {
  title: string;
  from: number;
  to: number;
}

export type Change =
  | { op: 'hide'; at: Target }
  | { op: 'text'; at: Target; text: string }
  | { op: 'role'; at: Target; role: Role }
  | { op: 'widget'; field: string; widget: Widget }
  | { op: 'button'; label: string; action: ButtonAction }
  /** Draw the item at `at` with its top-left cell at `to` instead (layout only). */
  | { op: 'move'; at: Target; to: Target }
  /** Restyle what matches a condition, e.g. rows whose Status column equals MSGW. */
  | { op: 'style'; when: StyleCondition; role: Role; target: StyleTarget }
  /**
   * A framed panel around the cells `from` to `to` (inclusive), with an
   * optional title on its top border. Positions are where items are drawn,
   * after moves.
   */
  | { op: 'card'; from: Target; to: Target; title?: string }
  /**
   * Split rows into tabs: each tab is a band of rows following the one before
   * it. One band shows at a time, under a strip of tab titles; hidden tabs
   * keep their fields, so their values are still sent. Rows are where items
   * are drawn, after moves. At most one per definition.
   */
  | { op: 'tabs'; tabs: TabBand[] }
  /**
   * A custom component (components/<name>.js on the server) drawn in a box
   * `width` x `height` cells at a position. With `field` (an input field id
   * such as "6:22") it replaces that field's input and can set its value; if
   * the component is missing or fails, the normal input is shown. `options`
   * are passed to the component as they are.
   */
  | { op: 'component'; name: string; at: Target; width: number; height: number; field?: string; options?: ComponentOptions }
  /**
   * Custom HTML drawn over the screen at a position, `width` x `height` cells.
   * `css` is scoped to the box (nested rules reach inside it); `script` runs
   * each time the screen is drawn, with `element` set to the box.
   */
  | { op: 'html'; at: Target; html: string; width: number; height: number; css?: string; script?: string };

export interface ScreenDefinition {
  /** File name and URL id: lowercase letters, digits and dashes. */
  id: string;
  name: string;
  match: Match;
  /** Replaces the detected page title. */
  title?: string;
  changes: Change[];
  /** CSS added to the page while this screen is shown. */
  css?: string;
  /** JavaScript run on screen events (see SCREEN_EVENTS). */
  scripts?: Partial<Record<ScreenEvent, string>>;
}

/**
 * When a screen's scripts run: `load` when the screen opens (coming from a
 * different screen), `show` every time it is drawn (paging, errors too).
 * Scripts are the body of `function (veneer, screen, element)` and may return
 * a cleanup function, called when the screen closes (`load`) or is redrawn (`show`).
 */
export const SCREEN_EVENTS = ['load', 'show'] as const;
export type ScreenEvent = (typeof SCREEN_EVENTS)[number];

/** When site-wide scripts run: `load` once when the page loads, `screen` after every screen. */
export const SITE_EVENTS = ['load', 'screen'] as const;
export type SiteEvent = (typeof SITE_EVENTS)[number];

/** Site-wide CSS and JavaScript (global.css, global.js and global-screen.js). The look is the theme (themes.ts). */
export interface SiteCustomization {
  css: string;
  scripts: Record<SiteEvent, string>;
}

/**
 * The designer's old Style section, saved as global.style.json before themes.
 * Only read now, to turn a saved style into a theme when a site upgrades.
 */
export const LOOKS = ['default', 'compact', 'flat', 'green', 'soft'] as const;
export type Look = (typeof LOOKS)[number];
export const CORNERS = ['square', 'round'] as const;
export const DENSITIES = ['compact', 'normal', 'roomy'] as const;
export const FONTS = ['sans', 'mono'] as const;

/** The site's style: a base look, with options that override it. An unset option follows the look. */
export interface SiteStyle {
  look: Look;
  /** Hex color; overrides VENEER_BRAND_ACCENT. */
  accent?: string;
  corners?: (typeof CORNERS)[number];
  density?: (typeof DENSITIES)[number];
  font?: (typeof FONTS)[number];
}
