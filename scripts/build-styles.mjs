import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tailwindCli = path.join(projectRoot, 'node_modules', 'tailwindcss', 'lib', 'cli.js');
const result = spawnSync(process.execPath, [
  tailwindCli,
  '-c', path.join(projectRoot, 'tailwind.config.js'),
  '-i', path.join(projectRoot, 'styles', 'design-system.css'),
  '-o', path.join(projectRoot, 'public', 'css', 'app.css'),
  '--minify',
], {
  cwd: projectRoot,
  env: { ...process.env, BROWSERSLIST_IGNORE_OLD_DATA: 'true' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
