require('dotenv').load({ silent: true });

var config = {};

config.webPort = process.env.WEB_PORT || 8000;
config.verboseLevel = 3;
config.logLevel = 3;

module.exports = config;
