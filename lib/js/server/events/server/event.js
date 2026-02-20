// Timestamp helper for log correlation with PHP (format: YYYY-MM-DD HH:MM:SS)
function ts() {
	return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

var event = {

	componentManager : null,

	name : 'event',

	init : function () {},

	/**
	 * Handle incoming event from PHP
	 *
	 * @param {Object} frame - The event frame from PHP
	 * @param {Function} [callback] - Optional ack callback for guaranteed delivery
	 */
	handler : function (frame, callback) {
		// DEBUG: Log all incoming events from PHP
		console.log(ts(), '[EVENT] Received from PHP:', JSON.stringify({
			eventName: frame.meta.data.event,
			room: frame.meta.data['room'] || null,
			channel: frame.meta.data['channel'] || null,
			frameType: frame.meta.type,
			hasAckCallback: typeof callback === 'function'
		}));

		var success = false;
		var error = null;

		try {
			if (frame.meta.data['room']) {
				event
					.componentManager
					.get('io')
					.of('/client')
					.in('room:' + frame.meta.data['room'])
					.emit('room:' + frame.meta.data['room'] + ':' + frame.meta.data.event, frame.data);
				success = true;
			} else if (frame.meta.data['channel']) {
				var channel = event
						.componentManager
						.get('channel')
						.channel
						.getByName(frame.meta.data['channel']);
				if (channel) {
					channel.emit(frame.meta.data.event, frame.data);
					success = true;
				} else {
					error = 'channel ' + frame.meta.data['channel'] + ' not found';
					console.log(ts(), '[EVENT] ERROR: ' + error);
				}
			} else {
				event.componentManager.get('io').of('/client').emit('global:' + frame.meta.data.event, frame.data);
				success = true;
			}
		} catch (e) {
			error = e.message;
			console.log(ts(), '[EVENT] Error processing event:', e);
		}

		// Call ack callback if provided (for guaranteed delivery)
		// This is optional - old clients that don't request acks still work
		if (typeof callback === 'function') {
			callback({
				status: success ? 'ok' : 'error',
				frameId: frame.meta.id,
				error: error
			});
		}
	}
};

module.exports = event;