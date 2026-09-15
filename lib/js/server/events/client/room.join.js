// Timestamp helper for log correlation with PHP (format: YYYY-MM-DD HH:MM:SS)
function ts() {
	return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

// Relay scaling (HAN-3426): the members-count broadcast used to go to the whole room on every
// join — O(N) per join, O(N²) in a reconnect storm (~5 M frames/min at 2,500 viewers, measured
// 2026-09-04). With RELAY_MEMBERS_EVERY_MS > 0 the broadcast is coalesced to one per room per
// interval, and the member count (a cross-process round trip when the Redis adapter is on) is
// taken once per interval instead of once per join. 0 keeps the original per-join behaviour.
const MEMBERS_EVERY_MS = parseInt(process.env.RELAY_MEMBERS_EVERY_MS || '0', 10);
const CROSS_PROCESS = !!process.env.RELAY_REDIS_URL;   // Redis adapter: rooms span processes
const pending = new Map();    // room -> { events: Set<eventSuffix> } awaiting the next broadcast
const lastCount = new Map();  // room -> count from the last broadcast (ack value while coalescing)
const COUNT_REQUEST = 'relay:roomCount';

function localCount(io, room) {
	const members = io.adapter.rooms.get(room);
	return members ? members.size : 0;
}

// Member count across processes. NOTE: under @socket.io/redis-adapter, allSockets() is LOCAL
// only (adapter.sockets() is not distributed) — only fetchSockets() and serverSideEmit() cross
// processes. fetchSockets() serialises every socket's handshake, so ask each process for its
// local room size instead; falls back to the local count on timeout (a hung peer must not
// stall the room) and in single-process mode.
function countMembers(io, room) {
	const local = localCount(io, room);
	if (!CROSS_PROCESS) return Promise.resolve(local);
	return new Promise((resolve) => {
		io.serverSideEmit(COUNT_REQUEST, room, (err, responses) => {
			if (err) {
				console.log(ts(), '[ROOM] cross-process count failed for ' + room + ':', err.message);
				return resolve(local);
			}
			resolve(local + responses.reduce((sum, n) => sum + (Number(n) || 0), 0));
		});
	});
}

// Every process must answer count requests from its peers from startup (server.js installs
// this), including processes that have not seen a join yet — otherwise the request times out.
function installCountResponder(io) {
	if (CROSS_PROCESS) io.on(COUNT_REQUEST, (room, reply) => reply(localCount(io, room)));
}

function scheduleMembersBroadcast(io, room, eventSuffix) {
	let p = pending.get(room);
	if (p) {
		p.events.add(eventSuffix);
		return;
	}
	p = { events: new Set([eventSuffix]) };
	pending.set(room, p);
	setTimeout(() => {
		pending.delete(room);
		countMembers(io, room).then((count) => {
			if (count > 0) lastCount.set(room, count); else lastCount.delete(room);
			for (const suffix of p.events) io.in(room).emit(room + suffix, count);
		}).catch((e) => {
			console.log(ts(), '[ROOM] members count failed for ' + room + ':', e.message);
		});
	}, MEMBERS_EVERY_MS);
}

// Joins `socket` to `room` and resolves with the member count to report back to the joiner.
function joinRoom(io, socket, room, eventSuffix) {
	if (!MEMBERS_EVERY_MS) {
		// Original behaviour: count, tell the room, then join.
		return countMembers(io, room).then((count) => {
			io.in(room).emit(room + eventSuffix, count + 1);
			socket.join(room);
			return count + 1;
		});
	}
	socket.join(room);
	scheduleMembersBroadcast(io, room, eventSuffix);
	const known = lastCount.get(room);
	const local = io.adapter.rooms.get(room);
	return Promise.resolve(known === undefined ? (local ? local.size : 1) : known + 1);
}

function makeRoomName(id) {
	return 'room:' + id;
}

var joinClient = {

	componentManager : null,

	name : 'room_join',

	init : function () {},

	handler : function (id, fn) {
		const io = joinClient.componentManager.get('io').of('/client');
		switch (typeof id) {

			case 'number':
			case 'string': {
				joinRoom(io, this, makeRoomName(id), ':system:room_members_count').then((count) => {
					if (typeof fn === 'function') {
						fn(true, count);
					}
				});
				return;
			}

			case 'object': {
				const socket = this;
				const isJoined = {};
				const numberOfRoomClients = {};
				const roomIds = Object.values(id).filter(function(val) {
					var type = typeof val;
					return val && (type == 'string' || type == 'number');
				});

				Promise.all(roomIds.map(function(roomId) {
					return joinRoom(io, socket, makeRoomName(roomId), ':room:system:update.members_count').then((count) => {
						isJoined[roomId] = true;
						numberOfRoomClients[roomId] = count;
					});
				})).then(function() {
					if (Object.keys(isJoined).length > 0 && typeof fn === 'function') {
						fn(isJoined, numberOfRoomClients);
					}
				});
				return;
			}
		}
		// fn(false, 'Invalid channel id, valid id types [string,number,array,object]');
	}
};

joinClient.installCountResponder = installCountResponder;

module.exports = joinClient;
