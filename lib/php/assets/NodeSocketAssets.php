<?php

namespace YiiNodeSocket\Assets;

use Yii;
use yii\web\AssetBundle;

/**
 * @author Woody <Woody@HandBid.com>
 * @since 1.0
 */
class NodeSocketAssets extends AssetBundle
{

    public $sourcePath = '@nodeWeb';

    /**
     * Overridden by Setting the above attribute it
     * Forces Yii into using the asset caching library.
     *
      public $basePath = '@webroot';
      public $baseUrl = '@web';
     *
     */
    public $css = [
    ];
    public $js = [
    ];
    public $depends = [
    ];

    public function init()
    {
        $this->js[] = $this->getSocketScriptPath();
        $this->js[] = 'client/client.js';
    }
    
    protected function getSocketScriptPath()
    {
        if (!(int)Yii::$app->nodeSocket->port) {
            $pathParts = [
                Yii::$app->nodeSocket->protocol, 
                '://',
                Yii::$app->nodeSocket->host, 
                '/socket.io/socket.io.js'
            ];
        } else {
            $pathParts = [
                Yii::$app->nodeSocket->protocol, 
                '://',
                Yii::$app->nodeSocket->host, 
                ':',
                Yii::$app->nodeSocket->port, 
                '/socket.io/socket.io.js'
            ];
        }
        return implode('', $pathParts);
    }

}
