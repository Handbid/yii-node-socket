<?php
/**
 * @var NodeSocket $nodeSocket
 * @var NodeSocketCommand $this
 */
?>
module.exports = {
    host : '0.0.0.0',
    port : parseInt('<?php echo $nodeSocket->port; ?>'),
    origin : '<?php echo $nodeSocket->getOrigin(); ?>',
    allowedServers : <?php echo json_encode($nodeSocket->getAllowedServersAddresses()); ?>,
    dbOptions : <?php echo json_encode($nodeSocket->getDb()->getConnectionOptions()); ?>,
    checkClientOrigin : <?php echo (int) $nodeSocket->checkClientOrigin; ?>,
    sessionVarName : '<?php echo $nodeSocket->sessionVarName; ?>',
    socketLogFile : '<?php echo $nodeSocket->socketLogFile; ?>',
    checkCertificates : '<?php echo $nodeSocket->checkCertificates; ?>',
    keyFile : '<?php echo $nodeSocket->keyFile; ?>',
    certFile : '<?php echo $nodeSocket->certFile; ?>'
};

<?php
