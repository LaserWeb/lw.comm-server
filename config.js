require('dotenv').load({ silent: true });

var config = {};

config.webPort = process.env.WEB_PORT || 8000;
config.serverVersion = '4.0.80';
config.apiVersion = '4.0.3';

config.verboseLevel = process.env.VERBOSE_LEVEL || 1;
config.logLevel = process.env.LOG_LEVEL || 0;

config.posDecimals = process.env.DRO_DECIMALS || 2;
config.firmwareWaitTime = process.env.FIRMWARE_WAIT_TIME || 10;

module.exports = config;
