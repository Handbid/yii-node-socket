module.exports = {
    host : '0.0.0.0',
    port : parseInt('3002'),
    origin : '*:*',
    allowedServers : ["127.0.0.1","0.0.0.0","localhost","10.0.18.16", "10.0.18.7", "10.0.18.18"],
    dbOptions : {"driver":"dummy","config":[]},
    checkClientOrigin : 0,
    isSecureConnection : 0,
    sessionVarName : 'PHPSESSID',
    socketLogFile : '/var/log/yii/node-socket.log',
    checkCertificates : '0',
    keyFile : '/etc/ssl/private/STAR.handbid.dev.key',
    certFile : '/etc/ssl/private/STAR.handbid.dev.bundle.pem',
};
