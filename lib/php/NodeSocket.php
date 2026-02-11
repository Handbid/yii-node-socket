<?php

namespace YiiNodeSocket;

use Yii;
use yii\base\Component;
use YiiNodeSocket\Assets\NodeSocketAssets;

require_once 'frames/IFrameFactory.php';
require_once 'frames/FrameFactory.php';

class NodeSocket extends Component {

    const SOCKET_IO_READ = true;
    
    const SOCKET_IO_WRITE = false;
    
    const SOCKET_IO_PROTOCOL = 1;

    const SOCKET_PROTOCOL_UNSECURE = 'http';

    const SOCKET_PROTOCOL_SECURE = 'https';
    
    /**
     * Node js server host to bind http and socket server
     * Valid values is:
     *   - valid ip address
     *   - domain name
     *
     * Domain name must be withoud http or https
     * Example:
     *
     * 'host' => 'test.com'
     * // or
     * 'host' => '84.25.159.52'
     *
     * @var string
     */
    public $host = '0.0.0.0';
    
    /**
     * request path after host
     * Example path is /client. Path typically refers to a file or location on a 
     * web server, e.g. /directory/file.html or /news/story/Big+Event so on
     *
     * @var string
     */
    public $webPath = '/client';
    
    /**
     * request path after host
     * Example path is /server. Path typically refers to a file or location on a 
     * web server, e.g. /directory/file.html or /news/story/Big+Event so on
     *
     * @var string
     */
    public $serverPath = '/server';
    
    /**
     * Are we using a secure protocol? (i.e. http vs https)
     * @var boolean
     */
    public $isSecureConnection = false;

    /**
     * If your session var name is SID or other change this value to it
     *
     * @var string
     */
    public $sessionVarName = 'PHPSESSID';

    /**
     * @var int by default is once month
     */
    public $cookieLifeTime = 2592000;

    /**
     * Port in integer type only
     *
     * @var int
     */
    public $port = 3001;

    /**
     * Internal host for PHP-to-Node server-to-server communication.
     * This bypasses external proxies (like Cloudflare) that may not forward Socket.io events.
     * In Docker: typically 'node' (container name)
     * In production: typically 'localhost' or internal IP
     *
     * @var string|null
     */
    public $internalHost = null;

    /**
     * Internal port for PHP-to-Node server-to-server communication.
     * Usually 3002 (the raw Node.js port, not the external proxy port)
     *
     * @var int|null
     */
    public $internalPort = null;

    /**
     * Can be string, every domain|ip separated by a comma
     * or array
     *
     * @var string|array
     */
    public $origin;

    /**
     * List of allowed servers
     *
     * Who can send server frames
     *
     * If is string, ip addresses should be separated by a comma
     *
     * @var string|array
     */
    public $allowedServerAddresses;

    /**
     * Default is runtime/socket-transport.server.log
     *
     * @var string
     */
    public $socketLogFile;

    /**
     * If set to false, any client can connect to websocket server
     *
     * @var bool
     */
    public $checkClientOrigin = true;

    /**
     * If set to false, php service client and server js do not validate certs
     *
     * @var bool
     */
    public $checkCertificates = true;

    /**
     * @var string
     */
    public $pidFile = 'socket-transport.pid';

    /**
     * @var string
     */
    public $keyFile = 'localhost.key';

    /**
     * @var string
     */
    public $certFile = 'localhost.crt';

    /**
     * @var int timeout for handshaking in miliseconds
     */
    public $handshakeTimeout = 2000;

    /**
     * @var array
     */
    public $dbConfiguration = ['driver' => 'dummy'];

    /**
     * @var string
     */
    protected $_assetUrl;

    /**
     * @var \YiiNodeSocket\Frames\FrameFactory
     */
    protected $_frameFactory;

    /**
     * @var \YiiNodeSocket\Components\Db
     */
    protected $_db;

    /**
     * @var \ElephantIO\Client
     */
    protected $_client;

    /**
     * @var \ElephantIO\Client|null Shared client for long-running consumers
     */
    private $_persistentClient = null;

    /**
     * @var bool Whether persistent mode is enabled (for consumer processes)
     */
    private $_persistentMode = false;

    public function init() {
        parent::init();

        // Standarized autoloader name for Yii extensions
        require_once 'Autoload.php';
        \YiiNodeSocket\Autoload::register(__DIR__);
        
        // check for standard autoloader method
        if (function_exists('__autoload')) {
            // Be polite and ensure that userland autoload gets retained
            spl_autoload_register('__autoload');
        }
        
        // Store a shared frame factory object
        $this->_frameFactory = new \YiiNodeSocket\Frames\FrameFactory($this);
        
        // Create and configure database component
        $this->_db = new \YiiNodeSocket\Components\Db($this);
        foreach ($this->dbConfiguration as $k => $v) {
            $this->_db->$k = $v;
        }
    }

    /**
     * @return \YiiNodeSocket\Frames\FrameFactory
     */
    public function getFrameFactory() {
        return $this->_frameFactory;
    }

    /**
     * @return \YiiNodeSocket\Components\Db
     */
    public function getDb() {
        return $this->_db;
    }

    /**
     * @return \YiiNodeSocket\Components\Db
     */
    public function getClient() {
        return $this->_client;
    }
    
    /**
     * Use Secure connection flag to return proper protocol
     * @return string
     */
    public function getProtocol()
    {
        if (Yii::$app->nodeSocket->isSecureConnection) {
            return static::SOCKET_PROTOCOL_SECURE;
        } 
        return static::SOCKET_PROTOCOL_UNSECURE;
    }
    
    /**
     * Use Secure connection flag to return proper protocol
     * @return string
     */
    public function getClientUrl()
    {
        if ($this->port) {
            return sprintf('%s://%s:%s%s',
                    $this->protocol,
                    $this->host,
                    $this->port,
                    $this->webPath);
        } else {
            return sprintf('%s://%s%s',
                    $this->protocol,
                    $this->host,
                    $this->webPath);
        }
    }
    
    /**
     * Use Secure connection flag to return proper protocol
     * @return JSON
     */
    public function getClientParams()
    {
        $params = [
            'secure' => Yii::$app->nodeSocket->isSecureConnection
        ];
        
        // Return parameters in JSON encoded format
        return json_encode($params);
    }

    /**
     * @return bool
     */
    public function registerClientScripts() {
        
        if ($this->_assetUrl) {
            return true;
        }
        
        $assets = NodeSocketAssets::register(\Yii::$app->getView());
        $this->_assetUrl = $assets->publish('@nodeWeb');
        if ($this->_assetUrl) {
            return true;
        }
        return false;
    }

    /**
     * @return string
     */
    public function getOrigin() {
        // $origin = $this->host . ':*';

        $origin = '';
        if ($this->origin) {
            $o = array();
            if (is_string($this->origin)) {
                $o = explode(',', $this->origin);
            }
            $o = array_map('trim', $o);
            if (in_array($origin, $o)) {
                unset($o[array_search($origin, $o)]);
            }
            if (!empty($o)) {
                $origin .= ' ' . implode(' ', $o);
            }
        }
        if (!$origin) {
            $origin = $this->host . ':*';
        }
        return $origin;
    }

    /**
     * @return string[]
     */
    public function getAllowedServersAddresses() {
        $allow = array();
        $serverIp = gethostbyname($this->host);
        $allow[] = $serverIp;
        if ($this->allowedServerAddresses && !empty($this->allowedServerAddresses)) {
            if (is_string($this->allowedServerAddresses)) {
                $allow = array_merge($allow, explode(',', $this->allowedServerAddresses));
            } else if (is_array($this->allowedServerAddresses)) {
                $allow = array_merge($allow, $this->allowedServerAddresses);
            }
        }
        return array_unique($allow);
    }

    /**
     * Enable persistent client mode.
     * Call this before a long-running consumer loop so that emit()
     * reuses a single Socket.io connection instead of connect/close per event.
     */
    public function enablePersistentClient() {
        $this->_persistentMode = true;
    }

    /**
     * Get the persistent Socket.io client, creating or reconnecting as needed.
     * Returns null when persistent mode is not enabled (normal web requests).
     *
     * @return \ElephantIO\Client|null
     */
    public function getPersistentClient() {
        if (!$this->_persistentMode) {
            return null;
        }

        // Return existing client if still connected
        if ($this->_persistentClient && $this->_persistentClient->isConnected()) {
            return $this->_persistentClient;
        }

        // Build internal URL (same logic as AFrame::createClient)
        $host = $this->internalHost
            ?: getenv('NODE_INTERNAL_HOST')
            ?: 'localhost';
        $port = $this->internalPort
            ?: getenv('NODE_INTERNAL_PORT')
            ?: 3002;
        $url = sprintf('http://%s:%s', $host, $port);

        $client = new \ElephantIO\Client(
            $url,
            'socket.io',
            self::SOCKET_IO_PROTOCOL,
            self::SOCKET_IO_WRITE
        );
        $client->setHandshakeTimeout($this->handshakeTimeout);
        $client->init();
        $client->of('/server');

        $this->_persistentClient = $client;
        return $this->_persistentClient;
    }

    /**
     * Release the persistent client and disable persistent mode.
     * Call this in a finally block after the consumer loop exits.
     */
    public function releasePersistentClient() {
        if ($this->_persistentClient) {
            try {
                $this->_persistentClient->close();
            } catch (\Throwable $e) {
                // Ignore close errors during cleanup
            }
            $this->_persistentClient = null;
        }
        $this->_persistentMode = false;
    }

}
