import YAML from 'yaml';

export const BASE_PORT = 42001;
const CONTROLLER = '127.0.0.1:19091';
const SECRET = 'ixb-ports';

export function decodeSubscription(buf) {
  let text = Buffer.from(buf).toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!/proxies\s*:/.test(text)) {
    const compact = text.replace(/\s+/g, '');
    if (compact.length > 32 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
      const decoded = Buffer.from(compact, 'base64').toString('utf8').replace(/^\uFEFF/, '').trim();
      if (/proxies\s*:/.test(decoded)) text = decoded;
    }
  }
  if (/^(ss|ssr|vmess|vless|trojan|hysteria2|hy2):\/\//m.test(text) && !/proxies\s*:/.test(text)) {
    throw new Error('这是节点分享链接，不是 Clash YAML。请换用 Clash 订阅地址。');
  }
  let doc;
  try {
    doc = YAML.parse(text, { merge: true, maxAliasCount: 1000 });
  } catch (err) {
    throw new Error(`订阅不是合法的 Clash YAML：${err.message}`);
  }
  const list = Array.isArray(doc) ? doc : doc && doc.proxies;
  if (!Array.isArray(list)) {
    throw new Error('订阅里没有 proxies 列表。请确认这是 Clash 订阅，不是只有 proxy-providers 的配置。');
  }
  return list;
}

function usable(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (!raw.name || !raw.type || !raw.server || raw.port == null || raw.port === '') return false;
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port <= 1 || port > 65535) return false;
  if (String(raw.server) === '0.0.0.0') return false;
  return true;
}

function clean(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

export function prepareProxies(list) {
  const skipped = [];
  const usableList = [];
  for (const raw of list) {
    if (!usable(raw)) {
      skipped.push(raw && raw.name ? String(raw.name) : '(无名称)');
      continue;
    }
    usableList.push(raw);
  }

  const seenNames = new Set();
  const identityCount = new Map();
  const nodes = usableList.map((raw) => {
    const original = String(raw.name).replace(/\s+/g, ' ').trim();
    let name = original;
    let n = 2;
    while (seenNames.has(name)) {
      name = `${original} #${n}`;
      n += 1;
    }
    seenNames.add(name);

    const type = String(raw.type);
    const server = String(raw.server);
    const serverPort = Number(raw.port);
    const base = [original, type, server, String(serverPort)].join('|');
    const occurrence = (identityCount.get(base) || 0) + 1;
    identityCount.set(base, occurrence);
    const identity = occurrence === 1 ? base : `${base}|#${occurrence}`;

    return {
      name,
      type,
      server,
      serverPort,
      identity,
      proxy: clean({ ...raw, name, port: serverPort }),
    };
  });

  return { nodes, skipped };
}

function validPort(port) {
  return Number.isInteger(port) && port >= BASE_PORT && port <= 65535;
}

export function assignPorts(nodes, saved) {
  const map = { ...(saved && saved.map) };
  let next = validPort(saved && saved.next) ? saved.next : BASE_PORT;
  const reserved = new Set(Object.values(map).filter(validPort));
  const usedThisRun = new Set();

  for (const node of nodes) {
    let port = map[node.identity];
    if (!validPort(port) || usedThisRun.has(port)) {
      while (reserved.has(next) || usedThisRun.has(next)) {
        next += 1;
        if (next > 65535) throw new Error('本地端口已经用完');
      }
      port = next;
      map[node.identity] = port;
      reserved.add(port);
      next += 1;
    }
    usedThisRun.add(port);
    node.localPort = port;
    node.socks = `127.0.0.1:${port}`;
  }

  nodes.sort(compareNodes);
  return { map, next };
}

export function compareNodes(a, b) {
  const aIsp = String(a.name).toUpperCase().includes('ISP') ? 0 : 1;
  const bIsp = String(b.name).toUpperCase().includes('ISP') ? 0 : 1;
  if (aIsp !== bIsp) return aIsp - bIsp;
  return a.localPort - b.localPort;
}

export function buildRuntime(nodes) {
  const doc = {
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': 'info',
    ipv6: false,
    'find-process-mode': 'off',
    'external-controller': CONTROLLER,
    secret: SECRET,
    proxies: nodes.map((node) => node.proxy),
    listeners: nodes.map((node) => ({
      name: `p${node.localPort}`,
      type: 'socks',
      port: node.localPort,
      listen: '127.0.0.1',
      proxy: node.name,
      udp: true,
    })),
    rules: ['MATCH,DIRECT'],
  };
  return YAML.stringify(doc);
}

export function publicNode(node) {
  return {
    name: node.name,
    type: node.type,
    server: node.server,
    serverPort: node.serverPort,
    localPort: node.localPort,
    socks: `127.0.0.1:${node.localPort}`,
  };
}

export { CONTROLLER, SECRET };
