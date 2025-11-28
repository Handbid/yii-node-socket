<?php
namespace YiiNodeSocket\Frames;

use YiiNodeSocket\NodeSocket;

abstract class AFrame implements \ArrayAccess {

	const TYPE_EVENT = 'event';
	const TYPE_SUBSCRIPTION = 'subscription';
	const TYPE_VOLATILE_ROOM_EVENT = 'volatile_room_event';
	const TYPE_CHANNEL_EVENT = 'channel_event';
	const TYPE_MULTIPLE_FRAME = 'multi_frame';
	const TYPE_RUNTIME_CONFIGURATION = 'runtime_configuration';
	const TYPE_PUBLIC_DATA = 'public_data';
	const TYPE_INVOKE = 'invoke';
	const TYPE_JQUERY = 'jquery';
	const TYPE_LOGOUT = 'logout';

	protected $_id;

	/**
	 * @var \NodeSocket
	 */
	protected $_nodeSocket;

	/**
	 * @var array
	 */
	protected $_container;

	/**
	 * @var bool
	 */
	private $_isAsMultiple = false;

	/**
	 * @return string
	 */
	abstract public function getType();

	/**
	 * @return bool
	 */
	abstract public function isValid();

	/**
	 * @param \NodeSocket $nodeSocket
	 */
	public function __construct(\YiiNodeSocket\NodeSocket $nodeSocket) {
		$this->_nodeSocket = $nodeSocket;
		$this->_createContainer();
		$this->init();
	}

	/**
	 * @return mixed
	 */
	public function getId() {
		if (isset($this->_id)) {
			return $this->_id;
		}
		return $this->_id = time() . ':' .uniqid();
	}

	public function send() {

		//  call before send event
		if ($this->isValid() && $this->beforeSend()) {

			//  check - if frame is not multiple
			//  then send frame
			if (!$this->_isAsMultiple) {

				//  prepare frame to send
				$this->prepareFrame();

				//  emit
				$this->emit();
			}
		}
	}

	/**
	 * Will be called before emit and after isValid & beforeSend methods
	 */
	public function prepareFrame() {}

	/**
	 * @param array $data
	 *
	 * @return AFrame
	 */
	public function setData(array $data) {
		$this->_container['data'] = $data;
		return $this;
	}

	/**
	 * @return string
	 */
	public function getEncodedFrame() {
		return json_encode($this->getFrame());
	}

	/**
	 * @return array
	 */
	final public function getFrame() {
		return $this->_container;
	}

	/**
	 * @return array
	 */
	final public function getData() {
		return $this->_container['data'];
	}

	/**
	 * @return array
	 */
	final public function getMeta() {
		return $this->_container['meta'];
	}

	/**
	 * @return array
	 */
	final public function getMetaData() {
		return $this->_container['meta']['data'];
	}

	/**
	 * @param Multiple $multipleFrame
	 *
	 * @return AFrame
	 */
	final public function setAsMultiple(Multiple $multipleFrame) {
		if (!$this->_isAsMultiple) {
			$multipleFrame->addFrame($this);
			$this->_isAsMultiple = true;
		}
		return $this;
	}

	/**
	 * @return bool
	 */
	final public function isAsMultiple() {
		return $this->_isAsMultiple;
	}

	/**
	 * @return bool
	 */
	protected function beforeSend() {
		return true;
	}

	protected function emit() {
		$client = $this->createClient();
		$client->setHandshakeTimeout($this->_nodeSocket->handshakeTimeout);
		$client->init();

		// Socket.io 4.x compatible emit
		// API: emit(eventName, argsArray, namespace)
		$client->emit($this->getType(), [$this->getFrame()], '/server');

		$client->close();
	}

	/**
	 * @return \ElephantIO\Client
	 */
	protected function createClient() {
            if ($this->_nodeSocket->isSecureConnection) {
		return new \ElephantIO\Client(
                    sprintf('https://%s:%s', $this->_nodeSocket->host, $this->_nodeSocket->port) ,
                    'socket.io',
                    NodeSocket::SOCKET_IO_PROTOCOL,
                    NodeSocket::SOCKET_IO_WRITE
		);
            } else {
		return new \ElephantIO\Client(
                    sprintf('http://%s:%s', $this->_nodeSocket->host, $this->_nodeSocket->port) ,
                    'socket.io',
                    NodeSocket::SOCKET_IO_PROTOCOL,
                    NodeSocket::SOCKET_IO_WRITE
		);
            }
	}

	protected function init() {}

	/**
	 * @param array $data
	 *
	 * @return AFrame
	 */
	final protected function setMetaData(array $data) {
		$this->_container['meta']['data'] = $data;
		return $this;
	}

	/**
	 * @param string|int $key
	 * @param mixed $value
	 *
	 * @return AFrame
	 */
	final protected function addMetaData($key, $value) {
		if (is_string($key) || is_int($key)) {
			$this->_container['meta']['data'][$key] = $value;
		}
		return $this;
	}

	/**
	 * @param $key
	 *
	 * @return bool
	 */
	final protected function hasMetaData($key) {
		return array_key_exists($key, $this->_container['meta']['data']);
	}

	/**
	 * @param string|int $key
	 *
	 * @return AFrame
	 */
	final protected function removeMetaData($key) {
		if ($this->hasMetaData($key)) {
			unset($this->_container['meta']['data'][$key]);
		}
		return $this;
	}

	private function _createContainer() {
            
                if (get_class(\Yii::$app) == 'yii\web\Application') {
                    $sid = \Yii::$app->session->id;
                } else {
                    $sid = uniqid();
                }
		$this->_container = array(
			'meta' => array(
				'id' => $this->getId(),
				'type' => $this->getType(),
				'sid' => $sid,
				'data' => array()
			),
			'data' => array()
		);
	}

	/**
	 * (PHP 5 &gt;= 5.0.0)<br/>
	 * Whether a offset exists
	 * @link http://php.net/manual/en/arrayaccess.offsetexists.php
	 *
	 * @param mixed $offset <p>
	 *                      An offset to check for.
	 * </p>
	 *
	 * @return boolean true on success or false on failure.
	 * </p>
	 * <p>
	 *       The return value will be casted to boolean if non-boolean was returned.
	 */
	public function offsetExists(mixed $offset): bool {
		return array_key_exists($offset, $this->_container['data']);
	}

	/**
	 * (PHP 5 &gt;= 5.0.0)<br/>
	 * Offset to retrieve
	 * @link http://php.net/manual/en/arrayaccess.offsetget.php
	 *
	 * @param mixed $offset <p>
	 *                      The offset to retrieve.
	 * </p>
	 *
	 * @return mixed Can return all value types.
	 */
	public function offsetGet(mixed $offset): mixed {
		return array_key_exists($offset, $this->_container['data']) ? $this->_container['data'][$offset] : null;
	}

	/**
	 * (PHP 5 &gt;= 5.0.0)<br/>
	 * Offset to set
	 * @link http://php.net/manual/en/arrayaccess.offsetset.php
	 *
	 * @param mixed $offset <p>
	 *                      The offset to assign the value to.
	 * </p>
	 * @param mixed $value  <p>
	 *                      The value to set.
	 * </p>
	 *
	 * @return void
	 */
	public function offsetSet(mixed $offset, mixed $value): void {
		if (is_null($offset)) {
			$this->_container['data'][] = $offset;
		} else {
			$this->_container['data'][$offset] = $value;
		}
	}

	/**
	 * (PHP 5 &gt;= 5.0.0)<br/>
	 * Offset to unset
	 * @link http://php.net/manual/en/arrayaccess.offsetunset.php
	 *
	 * @param mixed $offset <p>
	 *                      The offset to unset.
	 * </p>
	 *
	 * @return void
	 */
    public function offsetUnset(mixed $offset): void {
		unset($this->_container['data'][$offset]);
	}
}