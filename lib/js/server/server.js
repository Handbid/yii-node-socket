const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');

const serverConfiguration = require('./server.config.js');

// Timestamp helper for log correlation with PHP (format: YYYY-MM-DD HH:MM:SS)
function ts() {
	return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

// ── Relay scaling (HAN-3425 / HAN-3426) ─────────────────────────────────────────
// One build serves every environment; behaviour is selected by environment variables so
// the same server.js runs as the single vendored process (nothing set) or as one of N
// processes behind haproxy. Measured on shadow-prod 2026-09-10 (handbid-infra
// shadow-prod/docs/performance/2026-09-03-chg-viewing-capacity.md §1i/§1j).
//
//   RELAY_ENGINE=ws|uws            uws => uWebSockets.js via io.attachApp (−55 % CPU/process)
//   RELAY_REDIS_URL=redis://host:port
//                                  set => @socket.io/redis-adapter so rooms span processes;
//                                  unset => single-process in-memory adapter (as before)
//   RELAY_PORT=<n>                 socket port (default: server.config port)
//   RELAY_HTTP_PORT=<n>            uws only: express side port for /healthz (default RELAY_PORT+1000)
//   RELAY_REUSEPORT=1              N processes share one port (Linux SO_REUSEPORT). Prefer one
//                                  RELAY_PORT per process behind haproxy: polling sessions need
//                                  affinity, which haproxy's backend list + balance source gives.
//   RELAY_INSTANCE=<label>         instance label in logs and /healthz
//   RELAY_MEMBERS_EVERY_MS=<ms>    coalesce room_members_count to one broadcast per room per
//                                  interval (see events/client/room.join.js); 0 = every join
//   RELAY_MAX_BUFFERED_BYTES=<n>   per-socket send-queue cap (default 16 MiB): ws engine drops
//                                  the socket, uws skips it until it drains (maxBackpressure)
//
// Payload compression is deliberately not an option: measured −48 % bytes for ×4.6 relay CPU
// (uWS's shared compressor shares zlib state, not output — one deflate per subscriber).
const relay = {
	engine: process.env.RELAY_ENGINE === 'uws' ? 'uws' : 'ws',
	redisUrl: process.env.RELAY_REDIS_URL || '',
	port: parseInt(process.env.RELAY_PORT || serverConfiguration.port, 10),
	reusePort: process.env.RELAY_REUSEPORT === '1',
	instance: process.env.RELAY_INSTANCE || '0',
	maxBufferedBytes: parseInt(process.env.RELAY_MAX_BUFFERED_BYTES || String(16 * 1024 * 1024), 10),
};
relay.httpPort = parseInt(process.env.RELAY_HTTP_PORT || String(relay.port + 1000), 10);
if (!Number.isInteger(relay.port) || relay.port < 1) {
	console.error(ts(), '[RELAY] invalid port:', process.env.RELAY_PORT || serverConfiguration.port);
	process.exit(1);
}
if (relay.engine === 'uws' && serverConfiguration.isSecureConnection) {
	console.error(ts(), '[RELAY] RELAY_ENGINE=uws requires isSecureConnection=0 (TLS terminates at haproxy)');
	process.exit(1);
}

const app = express();
app.use(cors({ origin: '*', credentials: true }));

// Health monitoring state
const health = {
	startedAt: Date.now(),
	lastEventAt: null,       // last event received from any PHP/Go server
	lastHeartbeatAt: null,   // last heartbeat event specifically
	eventsProcessed: 0
};

// HTTPS/HTTP
let server;
if (serverConfiguration.isSecureConnection) {
	const options = {
		key: fs.readFileSync(serverConfiguration.keyFile),
		cert: fs.readFileSync(serverConfiguration.certFile),
		requestCert: true
	};
	server = https.createServer(options, app);

	// HTTP → HTTPS redirect
	const httpApp = express();
	httpApp.use(cors({ origin: '*', credentials: true }));
	const httpServer = http.createServer(httpApp);
	const httpPort = relay.port - 1;

	httpApp.get('*', (req, res) => {
		const sslPort = req.port + 1;
		const httpHost = 'https://' + req.hostname + ':' + sslPort;
		res.redirect(httpHost + req.url);
	});

	httpServer.listen(httpPort);
} else {
	server = http.createServer(app);
}

// Socket.IO setup
// Ping interval/timeout are raised from the defaults (25 s / 20 s) because the PHP server
// namespace clients (elephant.io) idle between emits.
const io = new Server(server, {
	cors: {
		origin: '*',
		credentials: true
	},
	transports: ['websocket', 'polling'],
	allowEIO3: true,
	pingInterval: 120000,   // 2 minutes (was default 25s)
	pingTimeout: 60000      // 1 minute (was default 20s)
});

// Redis adapter: every process publishes each broadcast to Redis and delivers to its own
// slice of the sockets. PHP keeps emitting to whichever process it is connected to.
let ready = Promise.resolve();
if (relay.redisUrl) {
	const { createAdapter } = require('@socket.io/redis-adapter');
	const { createClient } = require('redis');
	const pub = createClient({ url: relay.redisUrl });
	const sub = pub.duplicate();
	for (const c of [pub, sub]) c.on('error', (e) => console.error(ts(), '[RELAY] redis error:', e.message));
	ready = Promise.all([pub.connect(), sub.connect()]).then(() => {
		io.adapter(createAdapter(pub, sub));
		console.log(ts(), `[RELAY] instance ${relay.instance}: redis adapter attached (${relay.redisUrl.replace(/\/\/[^@]*@/, '//')})`);
	}).catch((e) => {
		console.error(ts(), '[RELAY] redis adapter FAILED:', e.message);
		process.exit(1);
	});
}

// uWebSockets.js engine: socket.io hands the WebSocket work to uWS; express keeps /healthz on
// the side port and uWS answers / and /healthz on the socket port for haproxy checks.
let uws = null;
let uwsApp = null;
if (relay.engine === 'uws') {
	uws = require('uWebSockets.js');
	uwsApp = uws.App();
	const uwsHealthz = (res) => {
		const h = healthz();
		res.writeStatus(h.code === 200 ? '200 OK' : '503 Service Unavailable')
		   .writeHeader('content-type', 'application/json')
		   .end(JSON.stringify(h.body));
	};
	uwsApp.get('/healthz', uwsHealthz).get('/', uwsHealthz);
	io.attachApp(uwsApp, {
		compression: uws.DISABLED,
		idleTimeout: 0,                          // engine.io pings own liveness; uWS's 120 s default would cut idle viewers
		maxBackpressure: relay.maxBufferedBytes, // slow receivers are skipped until they drain, the heap does not balloon
	});
}

const storeProvider = require('express-session').MemoryStore;
const sessionStorage = new storeProvider();

const componentManager = require('./components/component.manager.js');
const eventManager = require('./components/event.manager.js');
const socketPull = require('./components/socket.pull.js');
const db = require('./components/db.js');

db.init(serverConfiguration.dbOptions);

componentManager.set('config', serverConfiguration);
componentManager.set('db', db);
componentManager.set('sp', socketPull);
componentManager.set('io', io);
componentManager.set('eventManager', eventManager);
componentManager.set('sessionStorage', sessionStorage);

// /client namespace
io.of('/client').use((socket, next) => {
	const sid = '123456789123456789'; // cookie.parse(...) or real session ID logic
	socket.handshake.sid = sid;

	sessionStorage.get(sid, (err, session) => {
		if (err || !session) {
			const newSession = {
				sid: sid,
				cookie: socket.handshake.headers.cookie || '',
				user: {
					role: 'guest',
					id: null,
					isAuthenticated: false
				}
			};
			sessionStorage.set(sid, newSession, () => {
				socket.handshake.session = newSession;
				next();
			});
		} else {
			socket.handshake.session = session;
			socket.handshake.uid = session.user.id;
			next();
		}
	});
}).on('connection', socket => {
	console.log(ts(), '[CLIENT NS] New browser connection:', socket.id, 'from:', socket.handshake.address);
	socketPull.add(socket);
	componentManager.get('channel').attachToChannels(socket);
	eventManager.client.bind(socket);

	socket.on('disconnect', (reason) => {
		console.log(ts(), '[CLIENT NS] Disconnected:', socket.id, 'reason:', reason);
	});
});

// /server namespace (PHP via elephant.io, Go node_event consumer). elephant.io connects per
// emit, so per-connection logging here is per-event logging — keep it to errors.
io.of('/server').use((socket, next) => {
	const address = socket.handshake.address;
	if (!address) {
		console.log(ts(), '[SERVER NS] ERROR: No address transmitted');
		return next(new Error('NO ADDRESS TRANSMITTED'));
	}

	// Handle "*" as wildcard to allow all servers
	const allowed = serverConfiguration.allowedServers.includes('*') ||
	                serverConfiguration.allowedServers.includes(address);

	if (!allowed) {
		console.log(ts(), '[SERVER NS] ERROR: Invalid server:', address, 'allowed:', serverConfiguration.allowedServers);
		return next(new Error('INVALID SERVER: ' + address));
	}
	socket.handshake.sid = address;
	next();
}).on('connection', socket => {
	// Track health state from PHP/Go events
	socket.onAny((eventName, ...args) => {
		health.lastEventAt = Date.now();
		health.eventsProcessed++;
		if (args[0] && args[0].data && args[0].data.type === 'heartbeat') {
			health.lastHeartbeatAt = Date.now();
		}
	});

	eventManager.server.bind(socket);
});

// Cross-process room member counts (see events/client/room.join.js)
require('./events/client/room.join.js').installCountResponder(io.of('/client'));

//mobile namespace
io.of('/mobile').use((socket, next) => {
	next(new Error('Unauthorized'));
}).on('connection', socket => {
	socketPull.add(socket);
	componentManager.get('channel').attachToChannels(socket);
	eventManager.client.bind(socket);
});

// /healthz — monitored by Uptime Robot (via haproxy) and, with N processes, by haproxy's
// httpchk per instance. Served by express, and by uWS on the socket port in uws mode.
const HEARTBEAT_STALE_MS = 10 * 60 * 1000; // 10 minutes
const STARTUP_GRACE_MS   = 15 * 60 * 1000; // 15 minutes grace before requiring heartbeat

function healthz() {
	const now = Date.now();
	const uptimeSeconds = Math.floor((now - health.startedAt) / 1000);
	const connectedClients = io.of('/client').sockets.size;

	let status = 'ok';
	let reason = null;

	const heartbeatAge = health.lastHeartbeatAt ? (now - health.lastHeartbeatAt) : null;
	const inGracePeriod = (now - health.startedAt) < STARTUP_GRACE_MS;

	if (heartbeatAge === null && !inGracePeriod) {
		status = 'degraded';
		reason = 'no heartbeat received since startup';
	} else if (heartbeatAge !== null && heartbeatAge > HEARTBEAT_STALE_MS) {
		status = 'degraded';
		reason = 'heartbeat stale (' + Math.floor(heartbeatAge / 1000) + 's ago)';
	}

	const body = {
		status,
		engine: relay.engine,
		instance: relay.instance,
		port: relay.port,
		adapter: relay.redisUrl ? 'redis' : 'memory',
		uptimeSeconds,
		connectedClients,
		eventsProcessed: health.eventsProcessed,
		lastEventAt: health.lastEventAt,
		lastHeartbeatAt: health.lastHeartbeatAt
	};
	if (reason) body.reason = reason;
	return { code: status === 'ok' ? 200 : 503, body };
}

app.get('/healthz', (req, res) => {
	const h = healthz();
	res.status(h.code).json(h.body);
});

// Backpressure guard for the ws engine: a socket whose kernel/userland send queue is not
// draining (stalled front hop, dead mobile link) otherwise holds every frame in the heap —
// 1.3 GB seen behind a stalled ALB node on shadow-prod. uws enforces the same cap natively.
if (relay.engine === 'ws' && relay.maxBufferedBytes > 0) {
	setInterval(() => {
		for (const socket of io.of('/client').sockets.values()) {
			const transport = socket.conn && socket.conn.transport;
			const raw = transport && transport.socket;   // ws.WebSocket on the websocket transport
			if (raw && raw.bufferedAmount > relay.maxBufferedBytes) {
				console.log(ts(), '[RELAY] dropping', socket.id, 'buffered', raw.bufferedAmount, 'bytes >', relay.maxBufferedBytes);
				socket.disconnect(true);
			}
		}
	}, 5000).unref();
}

// Start server — after the adapter is attached, so no socket is accepted before rooms span processes.
ready.then(() => {
	const label = `instance ${relay.instance}${relay.reusePort ? ', reusePort' : ''}`;
	if (uwsApp) {
		const listenOpts = relay.reusePort ? 0 : uws.LIBUS_LISTEN_EXCLUSIVE_PORT;
		uwsApp.listen(serverConfiguration.host, relay.port, listenOpts, (token) => {
			if (!token) {
				console.error(ts(), `[RELAY] uWS failed to listen on ${serverConfiguration.host}:${relay.port}`);
				process.exit(1);
			}
			console.log(ts(), `[SERVER] uWS listening on ${serverConfiguration.host}:${relay.port} (${label})`);
		});
		server.listen({ port: relay.httpPort, host: serverConfiguration.host, reusePort: relay.reusePort }, () => {
			console.log(ts(), `[SERVER] express/healthz on ${serverConfiguration.host}:${relay.httpPort}`);
		});
	} else {
		server.listen({ port: relay.port, host: serverConfiguration.host, reusePort: relay.reusePort }, () => {
			console.log(ts(), `[SERVER] Listening on ${serverConfiguration.host}:${relay.port} (${label})`);
		});
	}
});

// Origin check
if (serverConfiguration.checkClientOrigin) {
	console.log(ts(), '[SERVER] Set origin:', serverConfiguration.origin);
	// Note: In Socket.IO 4.x origin check is handled via CORS
}

componentManager.initCompleted();
