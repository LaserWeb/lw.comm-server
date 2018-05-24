require('dotenv').load({silent: true});
const path = require('path');

var config = {};

config.webPort = process.env.WEB_PORT || 8000;
config.serverVersion = '4.0.130';
config.apiVersion = '4.0.6';

config.verboseLevel = process.env.VERBOSE_LEVEL || 1;
config.logLevel = process.env.LOG_LEVEL || 0;
config.resetOnConnect = process.env.RESET_ON_CONNECT || 0;

config.posDecimals = process.env.DRO_DECIMALS || 2;
config.firmwareWaitTime = process.env.FIRMWARE_WAIT_TIME || 10;
config.grblWaitTime = process.env.GRBL_WAIT_TIME || 1;
config.smoothieWaitTime = process.env.SMOOTHIE_WAIT_TIME || 1;
config.tinygWaitTime = process.env.TINYG_WAIT_TIME || 1;

config.jobOnStart = '';
config.jobOnFinish = '';
config.jobOnAbort = '';

config.uipath = path.join(__dirname, '/app')

module.exports = config;
