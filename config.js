require('dotenv').load({ silent: true });

var config = {};

config.webPort = process.env.WEB_PORT || 8000;
config.serverVersion = '4.0.31'
config.apiVersion = '4.0.1';

config.verboseLevel = 1;
config.logLevel = 0;

config.posDecimals = 2;

module.exports = config;
