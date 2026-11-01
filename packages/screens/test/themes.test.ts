import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUILTIN_THEMES, THEME_NAME, THEME_VARIABLES, insertVariable, isBuiltinTheme, rebaseCss, themeBase, themeImageType, themeLogo, validateSite,
} from '../src/index.ts';

test('theme names are folder names: letters, digits, - and _', () => {
  for (const ok of ['acme', 'Acme_2', 'acme-corp', 'a', 'x'.repeat(40)]) assert.ok(THEME_NAME.test(ok), ok);
  for (const bad of ['', 'acme corp', '../x', 'a/b', 'a.b', 'x'.repeat(41), 'acmé', 'active.json']) assert.ok(!THEME_NAME.test(bad), bad);
  assert.ok(BUILTIN_THEMES.every((n) => THEME_NAME.test(n)));
  assert.ok(isBuiltinTheme('flat'));
  assert.ok(!isBuiltinTheme('acme'));
});

test('image file names and their types', () => {
  assert.equal(themeImageType('logo.svg'), 'image/svg+xml');
  assert.equal(themeImageType('Logo.PNG'), 'image/png');
  assert.equal(themeImageType('photo.jpeg'), 'image/jpeg');
  assert.equal(themeImageType('photo.jpg'), 'image/jpeg');
  assert.equal(themeImageType('bg.webp'), 'image/webp');
  assert.equal(themeImageType('spin.gif'), 'image/gif');
  for (const bad of ['theme.css', 'logo', '.logo.png', '-logo.png', 'a/logo.png', '..png', 'logo.png.exe', 'logo.svgz', 'my logo.png', `${'x'.repeat(61)}.png`]) {
    assert.equal(themeImageType(bad), undefined, bad);
  }
});

test('a theme\'s logo is its image named logo', () => {
  assert.equal(themeLogo(['bg.png', 'logo.svg']), 'logo.svg');
  assert.equal(themeLogo(['Logo.PNG']), 'Logo.PNG');
  assert.equal(themeLogo(['logo.png', 'logo.svg']), 'logo.png', 'one, the same every time');
  assert.equal(themeLogo(['logos.png', 'my-logo.png', 'bg.png']), undefined);
  assert.equal(themeLogo([]), undefined);
  assert.equal(themeBase('acme'), '/themes/acme/');
});

test('relative URLs in a theme point into its folder', () => {
  const base = '/themes/acme/';
  assert.equal(rebaseCss('.a { background: url(logo.png) }', base), '.a { background: url(/themes/acme/logo.png) }');
  assert.equal(rebaseCss('.a { background: url("./img/bg.svg") }', base), '.a { background: url("/themes/acme/img/bg.svg") }');
  assert.equal(rebaseCss(".a { background: url( 'x.gif' ) }", base), ".a { background: url('/themes/acme/x.gif') }");
  assert.equal(rebaseCss('@import "fonts.css";', base), '@import "/themes/acme/fonts.css";');
  assert.equal(rebaseCss('@font-face { src: url(font.woff2) format("woff2") }', base), '@font-face { src: url(/themes/acme/font.woff2) format("woff2") }');
  for (const keep of ['url(/brand/logo)', 'url(https://cdn.example.com/x.png)', 'url(data:image/png;base64,AAAA)', 'url(#gradient)', 'url()', 'url(HTTP://X/y.png)']) {
    assert.equal(rebaseCss(`.a { background: ${keep} }`, base), `.a { background: ${keep} }`, keep);
  }
  assert.equal(rebaseCss(':root { --brand-accent: #c8102e; }', base), ':root { --brand-accent: #c8102e; }');
});

test('inserting a CSS variable', () => {
  assert.equal(insertVariable('', '--brand-accent', '#c8102e'), ':root {\n  --brand-accent: #c8102e;\n}\n');
  assert.equal(insertVariable('.x { color: red }', '--bg', '#fff'), ':root {\n  --bg: #fff;\n}\n\n.x { color: red }', 'a :root rule at the top');
  assert.equal(insertVariable(':root {\n  --bg: #fff;\n}', '--text', '#000'), ':root {\n  --bg: #fff;\n  --text: #000;\n}');
  assert.equal(insertVariable(':root { --bg: #fff }', '--text', '#000'), ':root { --bg: #fff;\n  --text: #000;\n}', 'adds the missing semicolon');
  assert.equal(insertVariable(':root {\n  --bg: #fff;\n  --text: #111;\n}', '--bg', '#000'), ':root {\n  --bg: #000;\n  --text: #111;\n}', 'replaces the value');
  assert.equal(insertVariable(':root { --bg-2: #eee; --bg: #fff; }', '--bg', '#000'), ':root { --bg-2: #eee; --bg: #000; }', 'not a longer name');
  assert.equal(
    insertVariable('@media (prefers-color-scheme: dark) {\n  :root { --bg: #000; }\n}\n/* :root { */\n:root { --x: 1; }', '--bg', '#fff'),
    '@media (prefers-color-scheme: dark) {\n  :root { --bg: #000; }\n}\n/* :root { */\n:root { --x: 1;\n  --bg: #fff;\n}',
    'the top-level rule, not dark mode\'s or a comment',
  );
  assert.match(insertVariable('@media (x) { :root { --a: 1; } }', '--bg', '#fff'), /^:root \{\n {2}--bg: #fff;\n\}/, 'only a nested one: start a top-level one');
});

test('every variable the designer offers is documented with an example', () => {
  const names = THEME_VARIABLES.map((v) => v.name);
  assert.equal(new Set(names).size, names.length);
  for (const v of THEME_VARIABLES) {
    assert.match(v.name, /^--[a-z0-9-]+$/);
    assert.ok(v.about && v.example, v.name);
  }
  for (const key of ['--brand-accent', '--header-bg', '--radius', '--font', '--rh']) assert.ok(names.includes(key), key);
});

test('site customizations no longer carry a style; an old one is ignored', () => {
  const site = validateSite({ css: 'a{}', scripts: { load: '', screen: '' }, style: { look: 'neon' } });
  assert.deepEqual(site, { css: 'a{}', scripts: { load: '', screen: '' } });
});
