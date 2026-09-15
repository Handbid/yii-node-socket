// Relay scaling matrix (HAN-3426): spawns N relay processes from lib/js/server, joins a room from
// clients on different processes (websocket + polling), emits a PHP-style frame on process 1 and
// checks cross-process delivery, member-count broadcasts, acks and /healthz.
//
//   cd lib/js/server && npm install && npm install --no-save socket.io-client@4
//   cp <an environments/.../server.config.js> ./server.config.js   (host 127.0.0.1, port 3102, allowedServers ["*"])
//   node ../../../tests/js/relay-scale-matrix.js ws  1 -                        0      # vendored behaviour
//   node ../../../tests/js/relay-scale-matrix.js uws 4 redis://127.0.0.1:6379  1000   # QA/prod shape
//
// Arguments: <engine ws|uws> <processes> <redisUrl|-> <RELAY_MEMBERS_EVERY_MS>. Run from lib/js/server.
const { spawn } = require('child_process');
const http = require('http');
const { io } = require(require('path').join(process.cwd(), 'node_modules', 'socket.io-client'));
const [engine, nStr, redis, membersMs] = process.argv.slice(2);
const N = parseInt(nStr, 10); const BASE = 3102; const ROOM = '47962';
const procs = [];
const get = (port, path) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path, timeout: 2000 }, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => res({ code: r.statusCode, body: b })); }).on('error', rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHealthy(port) { for (let i = 0; i < 50; i++) { try { const h = await get(port, '/healthz'); if (h.code === 200) return JSON.parse(h.body); } catch (e) {} await sleep(100); } throw new Error('port ' + port + ' never healthy'); }
function client(port, opts) { return io(`http://127.0.0.1:${port}/client`, Object.assign({ transports: ['websocket'], forceNew: true, reconnection: false }, opts)); }
function joined(sock, id) { return new Promise((res) => sock.emit('room_join', id, (ok, count) => res({ ok, count }))); }
function waitFor(sock, evt, ms = 3000) { return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting ' + evt)), ms); sock.once(evt, (d) => { clearTimeout(t); res(d); }); }); }
let fails = 0; const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
(async () => {
  for (let i = 0; i < N; i++) {
    const env = Object.assign({}, process.env, { RELAY_ENGINE: engine, RELAY_PORT: String(BASE + i), RELAY_INSTANCE: String(i + 1), RELAY_MEMBERS_EVERY_MS: membersMs });
    if (redis !== '-') env.RELAY_REDIS_URL = redis;
    const p = spawn(process.execPath, [require('path').join(process.cwd(), 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => { if (process.env.V) process.stdout.write(`[p${i + 1}] ${d}`); });
    p.stderr.on('data', (d) => process.stdout.write(`[p${i + 1} ERR] ${d}`));
    procs.push(p);
  }
  try {
    const hz = [];
    for (let i = 0; i < N; i++) hz.push(await waitHealthy(BASE + i));
    ok(hz.every((h, i) => h.engine === engine && h.instance === String(i + 1) && h.adapter === (redis === '-' ? 'memory' : 'redis')), `healthz on socket port: ${JSON.stringify(hz[0])}`);
    if (engine === 'uws') { const e = await get(BASE + 1000, '/healthz'); ok(e.code === 200, 'express side port healthz ' + e.code); const r = await get(BASE, '/'); ok(r.code === 200, 'uws serves / for haproxy check'); }
    const A = client(BASE), B = client(BASE + (N > 1 ? 1 : 0)), C = client(BASE + (N > 1 ? 1 : 0), { transports: ['polling'] });
    await Promise.all([A, B, C].map((s) => new Promise((r) => s.on('connect', r))));
    ok(true, `clients connected: A ws p1, B ws p${N > 1 ? 2 : 1}, C polling p${N > 1 ? 2 : 1}`);
    const evtName = `room:${ROOM}:system:room_members_count`;
    const counts = []; [A, B, C].forEach((s) => s.on(evtName, (c) => counts.push(c)));
    const jA = await joined(A, ROOM); const jB = await joined(B, ROOM); const jC = await joined(C, ROOM);
    ok(jA.ok === true && jB.ok === true && jC.ok === true, `room_join acks: ${jA.count}, ${jB.count}, ${jC.count}`);
    await sleep(parseInt(membersMs, 10) + 800);
    const last = counts[counts.length - 1];
    ok(last === 3 && counts.every((c) => c <= 3), `members_count broadcast: values=${JSON.stringify(counts)} (must end at 3 = all three, across processes)`);
    // PHP-style frame into process 1 on the /server namespace
    const S = io(`http://127.0.0.1:${BASE}/server`, { transports: ['websocket'], forceNew: true, reconnection: false });
    await new Promise((r) => S.on('connect', r));
    const frame = { meta: { id: 'f1', type: 'event', data: { event: 'bid', room: ROOM } }, data: { bid: 123, amount: 500 } };
    const recv = Promise.all([A, B, C].map((s) => waitFor(s, `room:${ROOM}:bid`)));
    const ack = await new Promise((r) => S.emit('event', frame, r));
    ok(ack && ack.status === 'ok' && ack.frameId === 'f1', 'PHP frame ack ' + JSON.stringify(ack));
    const got = await recv;
    ok(got.every((d) => d && d.bid === 123), `bid frame delivered to A (p1), B, C across processes: ${JSON.stringify(got[1])}`);
    // heartbeat tracked
    await new Promise((r) => S.emit('event', { meta: { id: 'h', type: 'event', data: { event: 'heartbeat', type: 'heartbeat' } }, data: { type: 'heartbeat' } }, r));
    const h2 = await get(BASE, '/healthz'); const hb = JSON.parse(h2.body);
    ok(hb.eventsProcessed >= 2 && hb.lastHeartbeatAt, `health counters: events=${hb.eventsProcessed} heartbeat=${!!hb.lastHeartbeatAt}`);
    // leave: B disconnects -> count drops to 2 for the rest
    B.disconnect(); await sleep(parseInt(membersMs, 10) + 600);
    A.disconnect(); C.disconnect(); S.disconnect();
  } catch (e) { ok(false, 'exception ' + e.message); }
  procs.forEach((p) => p.kill('SIGTERM'));
  await sleep(300);
  console.log(fails ? `RESULT: ${fails} FAIL` : 'RESULT: ALL PASS');
  process.exit(fails ? 1 : 0);
})();
