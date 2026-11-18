import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { assignPorts, buildRuntime, decodeSubscription, prepareProxies } from '../lib.mjs';

const proxy = (name, extra = {}) => ({ name, type: 'socks5', server: '127.0.0.1', port: 11001, ...extra });
function prepare(list, saved = {}, previous = []) {
  const { nodes } = prepareProxies(decodeSubscription(Buffer.from(YAML.stringify({ proxies: list }))));
  const ports = assignPorts(nodes, saved, previous);
  return { nodes, ports };
}
const isp = () => [
  proxy('ISP·one', { 'dialer-proxy': 'subscription select group' }),
  proxy('ISP·two', { 'dialer-proxy': 'subscription select group' }),
];

test('importing two ISP exits creates their missing upstream group without dropping VPN nodes', () => {
  const { nodes } = prepare([proxy('FNY·美国03'), proxy('CC·🇺🇸 美国 A1'), proxy('SSNZ·美国-US-2'), proxy('Los Angeles4'), ...isp()]);
  const before = structuredClone(nodes);
  const doc = YAML.parse(buildRuntime(nodes));
  assert.equal(doc.proxies.length, 6);
  assert.equal(doc.listeners.length, 6);
  assert.equal(doc['proxy-groups']?.length, 1, 'ISP dialers must reference a generated group');
  const group = doc['proxy-groups'][0];
  assert.equal(group.type, 'url-test');
  assert.deepEqual(group.proxies, ['FNY·美国03', 'CC·🇺🇸 美国 A1', 'SSNZ·美国-US-2', 'Los Angeles4']);
  assert.equal(group.interval, 30);
  assert.equal(group.timeout, 3000);
  assert.equal(group.tolerance, 0);
  assert.equal(group.lazy, false);
  assert.equal(group['max-failed-times'], 1);
  assert.equal(group.url, 'https://www.gstatic.com/generate_204');
  for (const p of doc.proxies.filter(p => p.name.startsWith('ISP·'))) assert.equal(p['dialer-proxy'], group.name);
  assert.deepEqual(nodes, before, 'rendering must not rewrite saved identities or original dialers');
});

test('US candidates exclude ISP relays, chained proxies, and Costa Rica San José', () => {
  const { nodes } = prepare([
    proxy('New York'), proxy('Chicago'), proxy('Atlanta'), proxy('Miami'), proxy('Dallas'), proxy('Washington'), proxy('San Jose'),
    proxy('FNY·美国03'), proxy('US-01'), proxy('🇺🇸 West'),
    proxy('Tokyo'), proxy('San José'), proxy('🇨🇷 Costa Rica San Jose'), proxy('哥斯达黎加 圣何塞'), proxy('RUS-01'), proxy('ISP-Relay-New York'),
    proxy('美国 nested', { 'dialer-proxy': 'Tokyo' }), ...isp(),
  ]);
  const doc = YAML.parse(buildRuntime(nodes));
  assert.deepEqual(doc['proxy-groups']?.[0]?.proxies, [
    'New York', 'Chicago', 'Atlanta', 'Miami', 'Dallas', 'Washington', 'San Jose', 'FNY·美国03', 'US-01', '🇺🇸 West',
  ]);
  assert.equal(doc.proxies.find(p => p.name === '美国 nested')['dialer-proxy'], 'Tokyo');
});

test('an ISP import with no independent US candidate fails before replacing a runtime', () => {
  const { nodes } = prepare([proxy('Tokyo'), proxy('ISP-Relay-New York'), ...isp()]);
  assert.throws(() => buildRuntime(nodes), /美国.*前置|前置.*美国/);
});

test('a generated group cannot shadow a node with the same name', () => {
  const { nodes } = prepare([proxy('IXB·美国前置自动选择'), proxy('美国 usable'), ...isp()]);
  const doc = YAML.parse(buildRuntime(nodes));
  const group = doc['proxy-groups']?.[0];
  assert.ok(group);
  assert.ok(!doc.proxies.some(p => p.name === group.name));
  assert.ok(!group.proxies.includes(group.name));
});

test('existing local ports survive refresh and adding a second ISP exit', () => {
  const { ports } = prepare([proxy('美国 original'), isp()[0]]);
  const { nodes } = prepare([isp()[1], isp()[0], proxy('美国 original'), proxy('美国 new')], ports);
  const doc = YAML.parse(buildRuntime(nodes));
  assert.equal(doc.listeners.find(l => l.proxy === '美国 original').port, 42001);
  assert.equal(doc.listeners.find(l => l.proxy === 'ISP·one').port, 42002);
  assert.equal(doc.listeners.find(l => l.proxy === 'ISP·two').port, 42003);
  assert.ok(doc.listeners.every(l => l.listen === '127.0.0.1'));
  assert.equal(doc['proxy-groups']?.length, 1);
});

test('subscriptions without chained ISP nodes keep normal direct listeners', () => {
  const { nodes } = prepare([proxy('Tokyo'), proxy('美国 normal')]);
  const doc = YAML.parse(buildRuntime(nodes));
  assert.equal(doc['proxy-groups']?.length || 0, 0);
  assert.equal(doc.proxies.length, 2);
  assert.deepEqual(doc.listeners.map(l => l.proxy), ['Tokyo', '美国 normal']);
});

test('a subscription endpoint update keeps the currently used port for the same named node', () => {
  const first = prepare([proxy('美国 same node', { server: 'old.example', port: 11001 }), ...isp()]);
  const oldPorts = structuredClone(first.ports);
  const refreshed = prepare([
    proxy('美国 same node', { server: 'new.example', port: 12001 }), ...isp(), proxy('美国 new node'),
  ], first.ports, first.nodes);
  assert.equal(refreshed.nodes.find(n => n.name === '美国 same node').localPort, 42001);
  assert.equal(refreshed.nodes.find(n => n.name === 'ISP·one').localPort, 42002);
  assert.equal(refreshed.nodes.find(n => n.name === 'ISP·two').localPort, 42003);
  assert.equal(refreshed.nodes.find(n => n.name === '美国 new node').localPort, 42004);
  assert.deepEqual(first.ports, oldPorts, 'staging must not mutate the active port map');
  const again = prepare([
    proxy('美国 same node', { server: 'new.example', port: 12001 }), ...isp(), proxy('美国 new node'),
  ], refreshed.ports);
  assert.equal(again.nodes.find(n => n.name === '美国 same node').localPort, 42001, 'updated mapping must persist across restart');
});

test('unresolved non-ISP dialers fail with an actionable error', () => {
  const { nodes } = prepare([proxy('美国 chained', { 'dialer-proxy': 'missing group' })]);
  assert.throws(() => buildRuntime(nodes), /美国 chained.*missing group/);
});
