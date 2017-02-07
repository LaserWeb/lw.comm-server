require('dotenv').load({ silent: true });

var config = {};

config.webPort = process.env.WEB_PORT || 8000;
config.serverVersion = '4.0.12'
config.apiVersion = '4.0.1';

config.verboseLevel = 3;
config.logLevel = 0;

module.exports = config;
