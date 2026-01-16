const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const cors = require('cors');
const cookie = require('cookie');
const { Server } = require('socket.io');

const serverConfiguration = require('./server.config.js');

console.log('[DEBUG] Server.js loaded at', new Date().toISOString());

const app = express();
app.use(cors({ origin: '*', credentials: true }));

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
	const httpPort = serverConfiguration.port - 1;

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
const io = new Server(server, {
	cors: {
		origin: '*',
		credentials: true
	},
	transports: ['websocket', 'polling'],
	allowEIO3: true
});

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
	socketPull.add(socket);
	componentManager.get('channel').attachToChannels(socket);
	eventManager.client.bind(socket);
});

// /server namespace
console.log('[DEBUG] Setting up /server namespace');
io.of('/server').use((socket, next) => {
	console.log('[SERVER NS] Middleware hit! Address:', socket.handshake.address);
	const address = socket.handshake.address;
	if (!address) {
		console.log('[SERVER NS] ERROR: No address transmitted');
		return next(new Error('NO ADDRESS TRANSMITTED'));
	}

	// Handle "*" as wildcard to allow all servers
	const allowed = serverConfiguration.allowedServers.includes('*') ||
	                serverConfiguration.allowedServers.includes(address);
	console.log('[SERVER NS] Allowed servers:', serverConfiguration.allowedServers, 'Is allowed:', allowed);

	if (!allowed) {
		console.log('[SERVER NS] ERROR: Invalid server:', address);
		return next(new Error('INVALID SERVER: ' + address));
	}
	socket.handshake.sid = address;
	console.log('[SERVER NS] Middleware passed, calling next()');
	next();
}).on('connection', socket => {
	console.log('[SERVER NS] Connection callback fired! Address:', socket.handshake.address);

	// Debug: catch all events from PHP
	socket.onAny((eventName, ...args) => {
		console.log('[SERVER NS] Received event:', eventName, JSON.stringify(args).substring(0, 500));
	});

	eventManager.server.bind(socket);
});

//mobile namespace
io.of('/mobile').use((socket, next) => {
	next(new Error('Unauthorized'));
}).on('connection', socket => {
	socketPull.add(socket);
	componentManager.get('channel').attachToChannels(socket);
	eventManager.client.bind(socket);
});

// Start server
server.listen(serverConfiguration.port, serverConfiguration.host, () => {
	console.log(`Listening on ${serverConfiguration.host}:${serverConfiguration.port}`);
});

// Origin check
if (serverConfiguration.checkClientOrigin) {
	console.log('Set origin: ' + serverConfiguration.origin);
	// Note: In Socket.IO 4.x origin check is handled via CORS
}

componentManager.initCompleted();
