// Draws a custom component (custom/components.ts) in its box: mounts the
// module into an element React leaves alone, calls update when the screen or
// the bound field changes, and unmounts it when the box goes.

import { screenId } from '@veneer/screens';
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { componentFailed, mountComponent, tablesOf, useComponents, type ComponentContext, type ComponentInstance } from '../custom/components.ts';
import { screenInfo, veneer } from '../custom/runtime.ts';
import type { ComponentItem, ScreenView } from '../transform/types.ts';
import type { FieldBinding } from './fieldInput.tsx';

export function ComponentBox({ item, view, binding, design, className, style, dataAt }: {
  item: ComponentItem;
  view: ScreenView;
  binding: FieldBinding;
  design: boolean;
  className: string;
  style: CSSProperties;
  dataAt: string;
}) {
  const entry = useComponents()(item.name);
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<ComponentInstance | null>(null);
  const field = item.field;
  const value = field ? binding.value(field) : undefined;
  const options = JSON.stringify(item.options);

  const screen = useMemo(
    () => screenInfo(view.snapshot, screenId(view.snapshot), view.definition?.id),
    [view.snapshot, view.definition?.id],
  );
  const ctx: ComponentContext = {
    options: item.options,
    screen,
    tables: tablesOf(view),
    ...(field ? {
      field: { id: field.id, length: field.length },
      value: value!,
      setValue: (v: string) => { if (!design) binding.onChange(field, v.slice(0, field.length)); },
    } : {}),
    getField: (id) => veneer.getField(id),
    setField: (id, v) => { if (!design) veneer.setField(id, v); },
    press: (aid, fields) => { if (!design) veneer.press(aid, fields); },
    design,
  };
  const latest = useRef(ctx);
  latest.current = ctx;

  const module = entry.status === 'ready' ? entry.module : undefined;
  // What the component last drew, so update runs only when something changed.
  const drawn = useRef<unknown[]>([]);
  useEffect(() => {
    const el = host.current;
    if (!module || !el) return;
    try {
      instance.current = mountComponent(module, el, latest.current);
      drawn.current = [view.snapshot, value, options];
    } catch (err) {
      componentFailed(item.name, err);
      return;
    }
    return () => {
      const i = instance.current;
      instance.current = null;
      try {
        i?.unmount?.();
      } catch (err) {
        console.error(`Veneer: component "${item.name}" failed to unmount:`, err);
      }
      el.replaceChildren();
    };
    // Mounted once per module; later changes go to update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [module, item.name]);

  useEffect(() => {
    const now = [view.snapshot, value, options];
    if (!instance.current || now.every((x, k) => x === drawn.current[k])) return;
    drawn.current = now;
    try {
      instance.current.update?.(latest.current);
    } catch (err) {
      componentFailed(item.name, err);
    }
  });

  // A field's input comes back when its component is missing or failed; the
  // empty box is then only drawn in the designer, to select it.
  if (!module && field && !design && entry.status !== 'loading') return null;
  return (
    <div
      className={`custom-component${className}`}
      style={style}
      data-at={dataAt}
      data-component={dataAt}
      data-size={`${item.width}:${item.height}`}
    >
      <div ref={host} className="component-host" />
      {!module && design && (
        <span className="component-note">
          {entry.status === 'loading' ? 'Loading…'
            : entry.status === 'missing' ? `Component “${item.name}” is not installed` : `Component “${item.name}” failed (see the browser console)`}
        </span>
      )}
    </div>
  );
}
