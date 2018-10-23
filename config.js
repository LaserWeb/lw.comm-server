require('dotenv').load({ silent: true });

var config = {};

config.webPort = envSettingAsInt(process.env.WEB_PORT) || 8000;
config.serverVersion = '4.0.127';
config.apiVersion = '4.0.6';

config.verboseLevel = envSettingAsInt(process.env.VERBOSE_LEVEL) || 1;
config.logLevel = envSettingAsInt(process.env.LOG_LEVEL) || 0;
config.resetOnConnect = envSettingAsInt(process.env.RESET_ON_CONNECT) || 0;

config.posDecimals = envSettingAsInt(process.env.DRO_DECIMALS) || 2;
config.firmwareWaitTime = envSettingAsInt(process.env.FIRMWARE_WAIT_TIME) || 10;
config.grblWaitTime = envSettingAsInt(process.env.GRBL_WAIT_TIME) || 1;
config.smoothieWaitTime = envSettingAsInt(process.env.SMOOTHIE_WAIT_TIME) || 1;
config.tinygWaitTime = envSettingAsInt(process.env.TINYG_WAIT_TIME) || 1;



/**
 * Accepts the value from a process environment variable and returns and int
 * All Environment variables are provided as strings, so this will force to number and preserve undefined
 * @param {string} envVarValue Value from process.env.X 
 * @return {number | undefined} The integer number value of the environment variable or undefined if NAN or undefined
 */
function envSettingAsInt(envVarValue) {

    var value;

    if (typeof envVarValue === 'undefined') {
        return undefined;
    }

    if (typeof envVarValue !== 'number') {
        value = parseInt(envVarValue);

        if (isNaN(value)) {
            return undefined;
        }
    } else {
        value = envVarValue;
    }

    return value;

}



module.exports = config;
