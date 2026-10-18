import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const npmCli = process.env.npm_execpath;

function run(command, args, env = process.env) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!npmCli) throw new Error('Run this gate through npm: npm run release:gate');
run(process.execPath, [npmCli, 'run', 'test:static']);
run(process.execPath, [npmCli, 'run', 'audit:security']);
run(process.execPath, [npmCli, 'run', 'build']);

const port = String(process.env.PPE_RELEASE_PORT || '3107');
const qaUrl = `http://127.0.0.1:${port}/index.html`;
const nextBin = path.resolve('node_modules/next/dist/bin/next');
const server = spawn(process.execPath, [nextBin, 'start', '-p', port], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production' },
});

server.stdout.on('data', chunk => process.stdout.write(chunk));
server.stderr.on('data', chunk => process.stderr.write(chunk));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(qaUrl);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Production server did not become ready at ${qaUrl}`);
}

try {
  await waitForServer();
  const env = { ...process.env, PPE_QA_URL: qaUrl };
  run(process.execPath, ['scripts/production-browser-qa.mjs'], env);
  run(process.execPath, ['scripts/accessibility-browser-qa.mjs'], env);
  run(process.execPath, ['scripts/critical-flows-browser-qa.mjs'], env);
  console.log('\nRELEASE GATE PASSED');
} finally {
  server.kill();
}
