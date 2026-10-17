import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadLoadingManager() {
  const attributes = new Map();
  const classes = new Set(['hidden']);
  const title = { textContent: '' };
  const subtext = { textContent: '' };
  const overlay = {
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
    },
    querySelector: selector => selector === '#overlayTitle' ? title : subtext,
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const window = {};
  const context = {
    AbortController,
    console,
    document: { getElementById: id => id === 'loadingOverlay' ? overlay : null },
    performance: { now: () => 0 },
    setTimeout: callback => { callback(); return 1; },
    window,
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../public/js/loading-manager.js', import.meta.url), 'utf8'), context);
  return { manager: window.LoadingManager, overlay, title, attributes };
}

test('keeps the shared overlay visible until every action key finishes', () => {
  const { manager, overlay, title, attributes } = loadLoadingManager();

  manager.start('action.legacy', { message: 'กำลังเตรียมข้อมูล...' });
  manager.start('action.save', { message: 'กำลังบันทึก...' });
  assert.equal(title.textContent, 'กำลังบันทึก...');
  assert.equal(overlay.classList.contains('hidden'), false);
  assert.equal(attributes.get('aria-busy'), 'true');

  manager.stop('action.save');
  assert.equal(overlay.classList.contains('hidden'), false);
  assert.equal(title.textContent, 'กำลังเตรียมข้อมูล...');

  manager.stop('action.legacy');
  assert.equal(overlay.classList.contains('hidden'), true);
  assert.equal(attributes.get('aria-busy'), 'false');
});

test('keeps the overlay visible while the same action key has nested work', () => {
  const { manager, overlay } = loadLoadingManager();

  manager.start('action.save', { message: 'กำลังบันทึก...' });
  manager.start('action.save', { message: 'กำลังบันทึก...' });
  manager.stop('action.save');
  assert.equal(overlay.classList.contains('hidden'), false);

  manager.stop('action.save');
  assert.equal(overlay.classList.contains('hidden'), true);
});
