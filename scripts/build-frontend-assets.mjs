import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function copyAsset(source, destination) {
  const sourcePath = path.join(projectRoot, source);
  const destinationPath = path.join(projectRoot, destination);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath);
}

const fontWeights = ['300', '400', '500', '600', '700', '800'];
const assets = [
  ['node_modules/@fortawesome/fontawesome-free/css/all.min.css', 'public/vendor/fontawesome/css/all.min.css'],
  ['node_modules/@fortawesome/fontawesome-free/webfonts/fa-solid-900.woff2', 'public/vendor/fontawesome/webfonts/fa-solid-900.woff2'],
  ['node_modules/@fortawesome/fontawesome-free/webfonts/fa-regular-400.woff2', 'public/vendor/fontawesome/webfonts/fa-regular-400.woff2'],
  ['node_modules/@fortawesome/fontawesome-free/webfonts/fa-brands-400.woff2', 'public/vendor/fontawesome/webfonts/fa-brands-400.woff2'],
  ['node_modules/@fortawesome/fontawesome-free/webfonts/fa-v4compatibility.woff2', 'public/vendor/fontawesome/webfonts/fa-v4compatibility.woff2'],
];

const chartSourcePath = path.join(projectRoot, 'node_modules/chart.js/dist/chart.umd.js');
const chartDestinationPath = path.join(projectRoot, 'public/vendor/chart/chart.umd.js');
const chartSource = await readFile(chartSourcePath, 'utf8');
await mkdir(path.dirname(chartDestinationPath), { recursive: true });
await writeFile(
  chartDestinationPath,
  chartSource.replace(/\n?\/\/# sourceMappingURL=chart\.umd\.js\.map\s*$/, ''),
  'utf8',
);

for (const weight of fontWeights) {
  assets.push(
    [`node_modules/@fontsource/inter/files/inter-latin-${weight}-normal.woff2`, `public/fonts/inter-latin-${weight}-normal.woff2`],
    [`node_modules/@fontsource/sarabun/files/sarabun-latin-${weight}-normal.woff2`, `public/fonts/sarabun-latin-${weight}-normal.woff2`],
    [`node_modules/@fontsource/sarabun/files/sarabun-thai-${weight}-normal.woff2`, `public/fonts/sarabun-thai-${weight}-normal.woff2`],
  );
}

await Promise.all(assets.map(([source, destination]) => copyAsset(source, destination)));
console.log(`Prepared ${assets.length + 1} local production assets.`);
