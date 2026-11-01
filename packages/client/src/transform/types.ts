// The view model produced by the auto-transform pipeline. Every item keeps
// its 5250 row/column so the layout stays faithful to the original screen.

import type { ButtonAction, ComponentOptions, Role, ScreenEvent, TabBand, Widget } from '@veneer/screens';
import type { AidName, FieldSnapshot, ScreenSnapshot } from '@veneer/tn5250';

export type { Role, TabBand, Widget };

export interface Placed {
  /** 1-based row and column. */
  row: number;
  col: number;
  /** Width in character cells. */
  width: number;
  /** Hidden by a customization; only drawn (ghosted) in the designer. */
  hidden?: boolean;
  /**
   * Where the host put the item, when a customization moved it (row/col are
   * then where it is drawn). Customizations and the designer refer to items by
   * this position.
   */
  home?: { row: number; col: number };
}

export interface Action {
  aid: AidName;
  fields?: Record<string, string>;
}

export interface Option {
  value: string;
  label: string;
}

export interface TextItem extends Placed {
  kind: 'text';
  text: string;
  role: Role;
  reverse: boolean;
  underline: boolean;
}

export interface FieldItem extends Placed {
  kind: 'field';
  field: FieldSnapshot;
  /** Text label found to the left, for accessibility. */
  label?: string;
  /** Command line (follows "===>"). */
  command?: boolean;
  options?: Option[];
  /** Set by a customization: dropdown, checkbox or date picker. */
  widget?: Widget;
  /** Set by a style rule. */
  role?: Role;
  /** A custom component draws this field instead, when it is working (see ComponentItem). */
  component?: string;
}

export interface LinkItem extends Placed {
  kind: 'link';
  text: string;
  /** Leading menu number, e.g. "1". */
  key: string;
  action: Action;
}

export interface TableCell {
  col: number;
  width: number;
  text: string;
  role: Role;
  field?: FieldSnapshot;
  options?: Option[];
  widget?: Widget;
  /** Set when a style rule chose `role`, so it wins over a row highlight. */
  styled?: boolean;
}

export interface TableRow {
  row: number;
  cells: TableCell[];
  /** Set by a style rule: highlights the whole row. */
  role?: Role;
}

export interface TableColumn {
  col: number;
  width: number;
  header: string;
}

export interface TableItem extends Placed {
  kind: 'table';
  /** Rows covered, header included. */
  height: number;
  /** Number of header rows at the top of the table. */
  headerRows: number;
  columns: TableColumn[];
  rows: TableRow[];
  /** Host indicated more records ("More..."); false at "Bottom". */
  more: boolean;
}

/** Custom HTML from a screen definition, drawn over the screen. */
export interface HtmlItem extends Placed {
  kind: 'html';
  html: string;
  /** CSS scoped to the box, and JavaScript run with the box (see custom/runtime.ts). */
  css?: string;
  script?: string;
  /** Rows covered. */
  height: number;
}

/** A custom component from a screen definition (see custom/components.ts). */
export interface ComponentItem extends Placed {
  kind: 'component';
  name: string;
  options: ComponentOptions;
  /** The input field it replaces, if any. */
  field?: FieldSnapshot;
  /** Rows covered. */
  height: number;
}

export type Item = TextItem | FieldItem | LinkItem | TableItem | HtmlItem | ComponentItem;

export interface FunctionKey {
  aid: AidName;
  label: string;
}

/** A framed panel from a customization, around cells where items are drawn (inclusive). */
export interface Card {
  top: number;
  left: number;
  bottom: number;
  right: number;
  title?: string;
}

/** A pop-up window: rendered as a modal card over the dimmed screen. */
export interface WindowView {
  /** Interior of the window (border excluded), 1-based and inclusive. */
  top: number;
  left: number;
  bottom: number;
  right: number;
  title?: string;
  items: Item[];
  functionKeys: FunctionKey[];
  message?: { text: string; kind: 'error' | 'info' };
}

export interface ScreenView {
  rows: number;
  cols: number;
  title?: string;
  /** Other header text from the title row (program name, system name), shown in the page header. */
  meta: TextItem[];
  items: Item[];
  functionKeys: FunctionKey[];
  message?: { text: string; kind: 'error' | 'info' };
  /** Set when a pop-up window is active; `items` are then the dimmed background. */
  window?: WindowView;
  /** Buttons added by a customization, shown above the screen: press a key, or open a web page. */
  buttons: Array<{ label: string; action: ButtonAction }>;
  /** Panels and tabs from a customization; positions are where items are drawn. */
  cards?: Card[];
  tabs?: TabBand[];
  /** The screen definition applied, if any. */
  definition?: { id: string; name: string };
  /** The definition's CSS and JavaScript (see custom/runtime.ts). */
  css?: string;
  scripts?: Partial<Record<ScreenEvent, string>>;
  /**
   * Lists a customization hid (not drawn, but still read by components, so a
   * component such as cards can take a list's place).
   */
  hiddenTables?: TableItem[];
  snapshot: ScreenSnapshot;
}
