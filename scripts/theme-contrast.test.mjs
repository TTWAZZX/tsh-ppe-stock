import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const designSystem = readFileSync(new URL('../styles/design-system.css', import.meta.url), 'utf8');
const source = `${html}\n${designSystem}`;

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map(value => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

test('brand text pairs meet WCAG AA contrast for normal text', () => {
  const pairs = [
    ['#ffffff', '#1261a6', 'white on primary blue'],
    ['#ffffff', '#0b4c8c', 'white on strong blue'],
    ['#ffffff', '#0b3d73', 'white on navy'],
    ['#dbeeff', '#0b1f3a', 'muted blue-white on deep navy'],
    ['#0b3d73', '#b8ddff', 'navy on pale blue'],
    ['#ffffff', '#047857', 'white on success toast'],
    ['#ffffff', '#b45309', 'white on warning toast'],
    ['#ffffff', '#b91c1c', 'white on error toast'],
  ];

  for (const [foreground, background, label] of pairs) {
    assert.ok(
      contrastRatio(foreground, background) >= 4.5,
      `${label} should meet the 4.5:1 contrast threshold`,
    );
  }
});
test('light cyan remains an accent and is not used beneath white body text', () => {
  assert.doesNotMatch(html, /(?:to|from|via)-cyan-500[^"']*text-white/);
  assert.match(source, /--text-on-brand: #ffffff/);
  assert.match(source, /--text-on-brand-muted: #dbeeff/);
  assert.match(source, /disabled\\:bg-blue-400:disabled[^}]*color: var\(--brand-800\)/);
});
