import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const designSystem = await readFile(new URL('../styles/design-system.css', import.meta.url), 'utf8');
const accessibilityManager = await readFile(new URL('../public/js/accessibility-manager.js', import.meta.url), 'utf8');
const source = `${html}\n${designSystem}\n${accessibilityManager}`;

test('touch targets and focus treatments are centralized', () => {
  assert.match(source, /--touch-target:\s*2\.75rem/);
  assert.match(source, /--focus-ring:/);
  assert.match(source, /@media \(pointer: coarse\)/);
  assert.match(source, /min-width:\s*var\(--touch-target\)/);
  assert.match(source, /:focus-visible/);
});

test('dialogs expose semantics, focus trap, escape handling and focus restoration', () => {
  assert.match(source, /function configureAccessibleDialog\(modal\)/);
  assert.match(source, /modal\.setAttribute\('role', 'dialog'\)/);
  assert.match(source, /modal\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(source, /event\.key === 'Tab' && activeModal/);
  assert.match(source, /event\.key === 'Escape' && activeModal/);
  assert.match(source, /trigger\.focus\(\{ preventScroll: true \}\)/);
});

test('forms expose inline validation errors and an accessible summary', () => {
  assert.match(source, /function showFieldError\(field\)/);
  assert.match(source, /function showFormErrorSummary\(formOrId, message, focusTarget = null\)/);
  assert.match(source, /field\.setAttribute\('aria-invalid', 'true'\)/);
  assert.match(source, /summary\.setAttribute\('role', 'alert'\)/);
  assert.match(source, /document\.addEventListener\('invalid'/);
});

test('tables remain inside an accessible mobile scroll region', () => {
  assert.match(source, /function standardizeAccessibleTable\(table\)/);
  assert.match(source, /classList\.add\('ui-table-container'\)/);
  assert.match(source, /overflow-x:\s*auto/);
  assert.match(source, /container\.tabIndex = 0/);
});

test('tabs, toasts and reduced motion expose assistive state', () => {
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(source, /toast\.setAttribute\('aria-live'/);
  assert.match(source, /prefers-reduced-motion:\s*reduce/);
  assert.match(source, /animation-duration:\s*0\.01ms/);
});

test('the locked project width contract remains unchanged', () => {
  assert.match(source, /\.page-container > \.page > \.module-shell\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none !important;/);
  assert.match(source, /\.app-main\s*\{[\s\S]*?padding-inline:\s*var\(--app-gutter\)/);
  assert.doesNotMatch(source, /\.ui-component-scope\s*\{[^}]*max-width:/);
});
