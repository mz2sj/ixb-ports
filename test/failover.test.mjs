import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { assignPorts, buildRuntime, prepareProxies } from '../lib.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binary = [process.env.MIHOMO_BIN, '/opt/homebrew/bin/mihomo', '/usr/local/bin/mihomo'].find(p => p && fs.existsSync(p));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  do {
    const value = await fn();
    if (value) return value;
    await pause(250);
  } while (Date.now() < end);
  throw new Error('Expected mihomo state did not arrive before deadline');
}

// Real local SOCKS gateways make mihomo exercise the generated dialer chain.
async function gateway(t, delay = 0) {
  const sockets = new Set();
  const relay = { enabled: true, destinations: [] };
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let stage = 0;
    const receive = chunk => {
      if (!relay.enabled) return; // Accept TCP but hang, reproducing an upstream timeout.
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage !== 1 || buffer.length < 5) return;
      let host, end;
      if (buffer[3] === 1) {
        if (buffer.length < 10) return;
        host = [...buffer.subarray(4, 8)].join('.'); end = 8;
      } else if (buffer[3] === 3) {
        end = 5 + buffer[4];
        if (buffer.length < end + 2) return;
        host = buffer.toString('utf8', 5, end);
      } else { socket.destroy(); return; }
      const port = buffer.readUInt16BE(end);
      const pending = buffer.subarray(end + 2);
      stage = 2;
      socket.removeListener('data', receive);
      relay.destinations.push(port);
      const timer = setTimeout(() => {
        if (socket.destroyed) return;
        const remote = net.connect({ host, port });
        sockets.add(remote);
        remote.on('close', () => sockets.delete(remote));
        remote.on('error', () => socket.destroy());
        socket.on('close', () => remote.destroy());
        remote.once('connect', () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (pending.length) remote.write(pending);
          socket.pipe(remote).pipe(socket);
        });
      }, delay);
      socket.once('close', () => clearTimeout(timer));
    };
    socket.on('data', receive);
  });
  relay.port = await listen(server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return relay;
}

test('generated ISP chains automatically leave a timed-out US upstream and keep both exits usable', { skip: !binary, timeout: 80000 }, async t => {
  const health = http.createServer((req, res) => { res.writeHead(204, { Connection: 'close' }); res.end(); });
  const healthPort = await listen(health);
  t.after(() => new Promise(resolve => health.close(resolve)));
  const fast = await gateway(t);
  const backup = await gateway(t, 120);
  const ispOne = await gateway(t);
  const ispTwo = await gateway(t);
  const free = net.createServer();
  const controllerPort = await listen(free);
  await new Promise(resolve => free.close(resolve));
  const { nodes } = prepareProxies([
    { name: '美国 fast', type: 'socks5', server: '127.0.0.1', port: fast.port },
    { name: '美国 backup', type: 'socks5', server: '127.0.0.1', port: backup.port },
    { name: 'ISP one', type: 'socks5', server: '127.0.0.1', port: ispOne.port, 'dialer-proxy': 'missing original group' },
    { name: 'ISP two', type: 'socks5', server: '127.0.0.1', port: ispTwo.port, 'dialer-proxy': 'missing original group' },
  ]);
  assignPorts(nodes, {});
  const doc = YAML.parse(buildRuntime(nodes));
  assert.equal(doc['proxy-groups']?.length, 1, 'generated runtime must resolve ISP dialers before core startup');
  const group = doc['proxy-groups'][0];
  // Keep the production interval/timeout; override only endpoints and inbound ports.
  doc['external-controller'] = `127.0.0.1:${controllerPort}`;
  doc.listeners = [];
  doc['log-level'] = 'silent';
  group.url = `http://127.0.0.1:${healthPort}/generate_204`;
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const config = path.join(root, `data/runtime.yaml.failover-test-${process.pid}`);
  const workdir = fs.mkdtempSync('/private/tmp/ixb-failover-');
  fs.writeFileSync(config, YAML.stringify(doc), { mode: 0o600 });
  const env = { ...process.env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
  const child = spawn(binary, ['-d', workdir, '-f', config], { env, stdio: 'ignore' });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  t.after(async () => {
    if (child.pid && child.exitCode === null && !child.signalCode) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([exited, pause(2000)]);
      if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exited; }
    }
    fs.rmSync(config, { force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
  });
  const api = async endpoint => {
    const response = await fetch(`http://127.0.0.1:${controllerPort}${endpoint}`, {
      headers: { Authorization: `Bearer ${doc.secret}` }, signal: AbortSignal.timeout(6000),
    });
    assert.ok(response.ok, `mihomo ${endpoint} HTTP ${response.status}`);
    return response.json();
  };
  await until(async () => {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, 'isolated core exited unexpectedly');
    try { await api('/version'); return true; } catch { return false; }
  });
  const delayQuery = new URLSearchParams({ url: group.url, timeout: '3000' });
  await api(`/group/${encodeURIComponent(group.name)}/delay?${delayQuery}`);
  const selection = () => api(`/proxies/${encodeURIComponent(group.name)}`);
  await until(async () => (await selection()).now === '美国 fast');
  const probe = async name => {
    const result = await api(`/proxies/${encodeURIComponent(name)}/delay?${delayQuery}`);
    assert.ok(result.delay > 0, `${name} must reach the HTTP endpoint through its upstream`);
  };
  await probe('ISP one');
  await probe('ISP two');
  assert.ok(fast.destinations.includes(ispOne.port));
  assert.ok(fast.destinations.includes(ispTwo.port));

  fast.enabled = false;
  await until(async () => (await selection()).now === '美国 backup', 50000);
  await probe('ISP one');
  await probe('ISP two');
  assert.ok(backup.destinations.includes(ispOne.port));
  assert.ok(backup.destinations.includes(ispTwo.port));
});
