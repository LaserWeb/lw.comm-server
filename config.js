require('dotenv').load({ silent: true });

var config = {};

config.webPort = process.env.WEB_PORT || 8000;
config.logFile = true;

module.exports = config;
