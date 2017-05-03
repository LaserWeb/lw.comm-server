require('dotenv').load({ silent: true });

var config = {};

config.webPort = process.env.WEB_PORT || 8000;
config.serverVersion = '4.0.68';
config.apiVersion = '4.0.2';

config.verboseLevel = process.env.VERBOSE_LEVEL || 1;
config.logLevel = process.env.LOG_LEVEL || 0;

config.posDecimals = process.env.DRO_DECIMALS || 2;

module.exports = config;
