import { spawn } from 'node:child_process';

const tunnelOrigin = 'http://127.0.0.1:8081';
const urlPattern = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i;

let tunnel;
let expo;
let shuttingDown = false;
let tunnelOutput = '';

function stop(child) {
  if (child && !child.killed) child.kill('SIGTERM');
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  stop(expo);
  stop(tunnel);
  process.exitCode = exitCode;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown());
}

function startExpo(proxyUrl) {
  console.log(`\nTunnel ready: ${proxyUrl}`);
  console.log('Starting Expo with this public URL…\n');

  expo = spawn('expo', ['start', '--localhost', '--clear'], {
    env: { ...process.env, EXPO_PACKAGER_PROXY_URL: proxyUrl },
    stdio: 'inherit',
  });

  expo.on('exit', (code) => shutdown(code ?? 0));
  expo.on('error', (error) => {
    console.error(`Unable to start Expo: ${error.message}`);
    shutdown(1);
  });
}

function handleTunnelOutput(chunk) {
  const output = chunk.toString();
  process.stderr.write(output);

  if (expo) return;
  tunnelOutput += output;
  const proxyUrl = tunnelOutput.match(urlPattern)?.[0];
  if (proxyUrl) startExpo(proxyUrl);
}

tunnel = spawn('cloudflared', ['tunnel', '--url', tunnelOrigin], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

tunnel.stdout.on('data', handleTunnelOutput);
tunnel.stderr.on('data', handleTunnelOutput);
tunnel.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`Cloudflare tunnel stopped unexpectedly (code ${code ?? 'unknown'}).`);
    shutdown(1);
  }
});
tunnel.on('error', (error) => {
  console.error(`Unable to start cloudflared: ${error.message}`);
  shutdown(1);
});
