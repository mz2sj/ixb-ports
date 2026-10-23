import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CONTROLLER,
  SECRET,
  assignPorts,
  buildRuntime,
  decodeSubscription,
  prepareProxies,
  publicNode,
} from './lib.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.IXB_DATA || path.join(ROOT, 'data');
const WEB_HOST = '127.0.0.1';
const WEB_PORT = Number(process.env.IXB_PORT || 8787);
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const PORTS_FILE = path.join(DATA, 'ports.json');
const NODES_FILE = path.join(DATA, 'nodes.json');
const RUNTIME_FILE = path.join(DATA, 'runtime.yaml');
const NEXT_FILE = path.join(DATA, 'runtime.next.yaml');
const LOG_FILE = path.join(DATA, 'mihomo.log');
const PID_FILE = path.join(DATA, 'mihomo.pid');
const MIHOMO_DIR = path.join(DATA, 'mihomo');
const INDEX_FILE = path.join(ROOT, 'public', 'index.html');

let settings = { url: '', updatedAt: '' };
let portMap = { map: {}, next: 42001 };
let snapshot = { updatedAt: '', skipped: [], nodes: [] };
let lastError = '';
let proc = null;
let queue = Promise.resolve();

function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function findMihomo() {
  const candidates = [
    process.env.MIHOMO_BIN,
    '/opt/homebrew/bin/mihomo',
    '/usr/local/bin/mihomo',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const found = spawnSync('which', ['mihomo'], { encoding: 'utf8' });
  const line = (found.stdout || '').trim().split('\n')[0];
  return line || '';
}

const MIHOMO = findMihomo();

function commandOf(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : '';
}

function killPid(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
}

async function reclaimStale() {
  if (!fs.existsSync(PID_FILE)) return;
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
  if (!pid) return;
  if (!commandOf(pid).includes(RUNTIME_FILE)) return;
  killPid(pid);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!commandOf(pid).includes(RUNTIME_FILE)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

function logTail() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-12).join('\n');
  } catch {
    return '';
  }
}

function clipError(error) {
  return String(error && error.message ? error.message : error).slice(0, 2000);
}

function loadDisk() {
  fs.mkdirSync(MIHOMO_DIR, { recursive: true });
  settings = { url: '', updatedAt: '', ...readJson(SETTINGS_FILE, {}) };
  portMap = { map: {}, next: 42001, ...readJson(PORTS_FILE, {}) };
  snapshot = { updatedAt: '', skipped: [], nodes: [], ...readJson(NODES_FILE, {}) };
}

function assertUrl(raw) {
  const text = String(raw || '').trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('订阅链接格式不对');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 http 或 https 订阅链接');
  }
  return url.toString();
}

async function fetchSubscription(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'clash-meta/1.19.33',
      Accept: 'text/yaml,application/yaml,text/plain,*/*',
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`订阅下载失败：HTTP ${response.status}`);
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > 5_000_000) throw new Error('订阅内容过大');
  return buf;
}

function testConfig(file) {
  const result = spawnSync(MIHOMO, ['-t', '-d', MIHOMO_DIR, '-f', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim().split('\n').slice(-8).join('\n');
    throw new Error(detail || 'mihomo 配置校验失败');
  }
}

function stopProc(child) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch { resolve(); }
  });
}

async function probeController() {
  try {
    const response = await fetch(`http://${CONTROLLER}/version`, {
      headers: { Authorization: `Bearer ${SECRET}` },
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitReady(child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(logTail() || `mihomo 退出了（${child.exitCode ?? child.signalCode}）`);
    }
    if (await probeController()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(logTail() || 'mihomo 没有在 8 秒内启动');
}

async function startMihomo() {
  if (!MIHOMO) throw new Error('找不到 mihomo。可以执行 brew install mihomo，或设置 MIHOMO_BIN。');
  if (!fs.existsSync(RUNTIME_FILE)) throw new Error('还没有生成节点配置');
  const previous = proc;
  proc = null;
  await stopProc(previous);
  await reclaimStale();
  fs.writeFileSync(LOG_FILE, '');
  const child = spawn(MIHOMO, ['-d', MIHOMO_DIR, '-f', RUNTIME_FILE], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv(process.env),
  });
  proc = child;
  fs.writeFileSync(PID_FILE, String(child.pid));
  const append = (chunk) => fs.appendFileSync(LOG_FILE, chunk);
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('exit', (code, signal) => {
    if (proc !== child) return;
    proc = null;
    if (code) lastError = logTail() || `mihomo 退出了（${code}${signal ? ` ${signal}` : ''}）`;
  });
  try {
    await waitReady(child);
    lastError = '';
  } catch (error) {
    await stopProc(child);
    if (proc === child) proc = null;
    throw error;
  }
}

function cleanEnv(env) {
  const next = { ...env };
  for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    delete next[key];
  }
  return next;
}

async function applySubscription(rawUrl) {
  if (!MIHOMO) throw new Error('找不到 mihomo。可以执行 brew install mihomo，或设置 MIHOMO_BIN。');
  const url = assertUrl(rawUrl);
  settings.url = url;
  writeJson(SETTINGS_FILE, settings);

  const body = await fetchSubscription(url);
  const { nodes, skipped } = prepareProxies(decodeSubscription(body));
  if (!nodes.length) throw new Error('订阅里没有可用节点');
  portMap = assignPorts(nodes, portMap);
  fs.writeFileSync(NEXT_FILE, buildRuntime(nodes), { mode: 0o600 });
  testConfig(NEXT_FILE);
  fs.renameSync(NEXT_FILE, RUNTIME_FILE);

  const updatedAt = new Date().toISOString();
  snapshot = { updatedAt, skipped, nodes: nodes.map(publicNode) };
  settings.updatedAt = updatedAt;
  writeJson(PORTS_FILE, portMap);
  writeJson(NODES_FILE, snapshot);
  writeJson(SETTINGS_FILE, settings);
  await startMihomo();
  return state();
}

function state() {
  return {
    url: settings.url || '',
    running: Boolean(proc && proc.exitCode === null && !proc.signalCode),
    pid: proc && proc.exitCode === null ? proc.pid : null,
    error: lastError,
    updatedAt: snapshot.updatedAt || '',
    skipped: snapshot.skipped || [],
    mihomo: MIHOMO || '',
    nodes: (snapshot.nodes || []).map((node) => ({
      ...node,
      socks: `127.0.0.1:${node.localPort}`,
    })),
  };
}

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error('请求太大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${WEB_HOST}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, state());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/subscribe') {
      const body = await readBody(req);
      const next = await enqueue(() => applySubscription(body.url));
      sendJson(res, 200, next);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      if (!settings.url) throw new Error('还没有保存订阅链接');
      const next = await enqueue(() => applySubscription(settings.url));
      sendJson(res, 200, next);
      return;
    }
    sendJson(res, 404, { error: '没有这个地址' });
  } catch (error) {
    lastError = clipError(error);
    sendJson(res, 400, { error: lastError, ...state(), error: lastError });
  }
});

async function shutdown() {
  server.close();
  const current = proc;
  proc = null;
  await stopProc(current);
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });

loadDisk();
server.listen(WEB_PORT, WEB_HOST, () => {
  console.log(`ixb-ports  http://${WEB_HOST}:${WEB_PORT}`);
  console.log(MIHOMO ? `mihomo     ${MIHOMO}` : 'mihomo     未找到');
  enqueue(async () => {
    await reclaimStale();
    if (fs.existsSync(RUNTIME_FILE)) await startMihomo();
  }).catch((error) => {
    lastError = clipError(error);
    console.error(lastError);
  });
});
