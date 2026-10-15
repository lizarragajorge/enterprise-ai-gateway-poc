import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');
// Node reads NODE_EXTRA_CA_CERTS before application code; load .env before starting it.
const server = spawn(process.execPath, ['--use-system-ca', 'server/index.ts'], {
  env: process.env, stdio: 'inherit'
});
server.on('error', error => {
  console.error('Unable to start local PoC:', error.message);
  process.exitCode = 1;
});
server.on('exit', (code, signal) => {
  if (signal) process.exitCode = 1;
  else process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.kill(signal));
}
