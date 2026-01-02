var joinClient = {

	componentManager : null,

	name : 'room_join',

	init : function () {},

	handler : function (id, fn) {
		console.log('Tying connect socket to room');
		switch (typeof id) {

			case 'number':
			case 'string':
				console.log('Room ' + id);
				joinToRoom(this, id, fn);
				return;
				break;

			case 'object':
				var socket = this;
				var isJoined = {};
				var numberOfRoomClients = {};
				var io = joinClient.componentManager.get('io').of('/client');
				var roomIds = Object.values(id).filter(function(val) {
					var type = typeof val;
					return val && (type == 'string' || type == 'number');
				});

				Promise.all(roomIds.map(function(roomId) {
					var room = makeRoomName(roomId);
					return io.in(room).allSockets().then(function(sockets) {
						var count = sockets.size;
						io.in(room).emit(room + ':room:system:update.members_count', count + 1);
						socket.join(room);
						console.log('Socket connected to ' + room);
						isJoined[roomId] = true;
						numberOfRoomClients[roomId] = count + 1;
					});
				})).then(function() {
					if (Object.keys(isJoined).length > 0 && typeof fn === 'function') {
						fn(isJoined, numberOfRoomClients);
					}
				});
				return;
		}
		// fn(false, 'Invalid channel id, valid id types [string,number,array,object]');
	}
};

function makeRoomName(id) {
	return 'room:' + id;
}

function joinToRoom(socket, roomId, fn) {
	const room = makeRoomName(roomId);
	const io = joinClient.componentManager.get('io').of('/client');

	io.in(room).allSockets().then((sockets) => {
		const count = sockets.size;
		io.in(room).emit(room + ':system:room_members_count', count + 1);
		socket.join(room);
		console.log('Socket connected');
		if (typeof fn === 'function') {
			fn(true, count + 1);
		}
	});
}

module.exports = joinClient;