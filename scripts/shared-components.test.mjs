import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const designSystem = readFileSync(new URL('../styles/design-system.css', import.meta.url), 'utf8');
const accessibilityManager = readFileSync(new URL('../public/js/accessibility-manager.js', import.meta.url), 'utf8');
const source = `${html}\n${designSystem}\n${accessibilityManager}`;
const moduleIds = [
  'dashboardPage',
  'stockPage',
  'issuePage',
  'loanPage',
  'allHistoryPage',
  'pendingPage',
  'managePage',
  'receivePage',
  'reportPage',
  'notificationsPage',
  'matrixPage',
];

test('shared component primitives are defined centrally', () => {
  for (const componentClass of [
    '.ui-page-header',
    '.ui-page-title',
    '.ui-card',
    '.ui-button',
    '.ui-button-primary',
    '.ui-button-secondary',
    '.ui-control',
    '.ui-filter-bar',
    '.ui-badge',
    '.ui-table',
    '.ui-empty-state',
    '.ui-loading-panel',
    '.ui-modal-panel',
    '.ui-toast',
  ]) assert.ok(source.includes(componentClass), `${componentClass} should exist`);

  for (const token of [
    '--control-height',
    '--component-padding',
    '--table-header-bg',
    '--modal-backdrop',
    '--shadow-modal',
  ]) assert.ok(source.includes(token), `${token} should exist`);
});
test('every user and admin module participates in the shared component layer', () => {
  for (const id of moduleIds) assert.match(html, new RegExp(`id="${id}"[\\s\\S]*?module-shell`));
  assert.match(source, /function applySharedComponentStyles\(root = document\)/);
  assert.match(source, /function observeSharedComponents\(\)/);
  assert.match(source, /observer\.observe\(document\.body, \{ childList: true, subtree: true, attributes: true, attributeFilter: \['class'\] \}\)/);
  assert.match(source, /applySharedComponentStyles\(\);\s*observeSharedComponents\(\);/);
});

test('dynamic empty states and toasts use shared components', () => {
  assert.match(html, /return `<div class="ui-empty-state">/);
  assert.match(html, /toast ui-toast ui-toast-\$\{type\}/);
  assert.match(source, /loadingPanel\?\.classList\.add\('ui-loading-panel'\)/);
  assert.match(source, /modal\.setAttribute\('role', 'dialog'\)/);
});

test('shared component work preserves the locked width contract', () => {
  assert.match(source, /\.page-container > \.page > \.module-shell\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none !important;/);
  assert.doesNotMatch(source, /\.ui-component-scope\s*\{[^}]*max-width/);
});
