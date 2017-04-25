"use strict";
/*

    AUTHOR:  Claudio Prezzi github.com/cprezzi

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
    WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
    MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
    ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
    WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
    ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
    OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.

*/

var config = require('./config');
var serialport = require('serialport');
var SerialPort = serialport;
var websockets = require('socket.io');
var http = require('http');
var WebSocket = require('ws');
var net = require('net');
var fs = require('fs');
var nstatic = require('node-static');
var url = require('url');
var util = require('util');
var chalk = require('chalk');
var request = require('request'); // proxy for remote webcams

var grblStrings = require('./grblStrings.js');

//var EventEmitter = require('events').EventEmitter;
//var qs = require('querystring');

var logFile;
var connectionType, connections = [];
var gcodeQueue = [];
var port, isConnected, connectedTo, portsList;
var machineSocket, connectedIp;
var telnetBuffer, espBuffer;

var statusLoop, queueCounter, listPortsLoop;
var lastSent = '', paused = false, blocked = false;

var firmware, fVersion, fDate;
var feedOverride = 100;
var spindleOverride = 100;
var laserTestOn = false;

var runningJob;
var startTime;
var queueLen;
var queuePos = 0;
var queuePointer = 0;
var readyToSend = true;

var optimizeGcode = false;

var supportedInterfaces = ['USB', 'ESP8266', 'Telnet'];

var GRBL_RX_BUFFER_SIZE = 128; // 128 characters
var grblBufferSize = [];
var new_grbl_buffer = false;

var SMOOTHIE_RX_BUFFER_SIZE = 64;  // max. length of one command line
var smoothie_buffer = false;
var lastMode;

var TINYG_RX_BUFFER_SIZE = 24;       // max. lines of gcode to send before wait for ok
var tinygBufferSize = TINYG_RX_BUFFER_SIZE; // init space left
var jsObject;

var xPos = 0, yPos = 0, zPos = 0;

const path = require('path');

require('dns').lookup(require('os').hostname(), function (err, add, fam) {
    writeLog(chalk.green(' '), 0);
    writeLog(chalk.green('***************************************************************'), 0);
    writeLog(chalk.white('        ---- LaserWeb Comm Server ' + config.serverVersion + ' ----        '), 0);
    writeLog(chalk.green('***************************************************************'), 0);
    writeLog(chalk.white('  Use ') + chalk.yellow(' http://' + add + ':' + config.webPort) + chalk.white(' to connect this server.'), 0);
    writeLog(chalk.green('***************************************************************'));
    writeLog(chalk.green(' '), 0);
    writeLog(chalk.red('* Updates: '), 0);
    writeLog(chalk.green('  Remember to check the commit log on'), 0);
    writeLog(chalk.yellow('  https://github.com/LaserWeb/lw.comm-server/commits/master'), 0);
    writeLog(chalk.green('  regularly, to know about updates and fixes, and then when ready'), 0);
    writeLog(chalk.green('  update accordingly by running ') + chalk.cyan('git pull'), 0);
    writeLog(chalk.green(' '), 0);
    writeLog(chalk.red('* Support: '), 0);
    writeLog(chalk.green('  If you need help / support, come over to '), 0);
    writeLog(chalk.green('  ') + chalk.yellow('https://plus.google.com/communities/115879488566665599508'), 0);
    writeLog(chalk.green('***************************************************************'), 0);
    writeLog(chalk.green(' '), 0);
});


// Init webserver
var webServer = new nstatic.Server(path.join(__dirname, '/app'));
var app = http.createServer(function (req, res) {
    var queryData = url.parse(req.url, true).query;
    if (queryData.url) {
        if (queryData.url !== '') {
            request({
                url: queryData.url, // proxy for remote webcams
                callback: function (err, res, body) {
                    if (err) {
                        // writeLog(err)
                        console.error(chalk.red('ERROR:'), chalk.yellow(' Remote Webcam Proxy error: '), chalk.white('"' + queryData.url + '"'), chalk.yellow(' is not a valid URL: '));
                    }
                }
            }).on('error', function (e) {
                res.end(e);
            }).pipe(res);
        }
    } else {
        webServer.serve(req, res, function (err, result) {
            if (err) {
                console.error(chalk.red('ERROR:'), chalk.yellow(' webServer error:' + req.url + ' : '), err.message);
            }
        });
    }
});
app.listen(config.webPort);
var io = websockets.listen(app);


// WebSocket connection from frontend
io.sockets.on('connection', function (appSocket) {

    // save new connection
    connections.push(appSocket);
    writeLog(chalk.yellow('App connected! (id=' + connections.indexOf(appSocket) + ')'), 1);

    // send supported interfaces
    appSocket.emit('interfaces', supportedInterfaces);
    
    // check available ports
    serialport.list(function (err, ports) {
        portsList = ports;
        appSocket.emit('ports', portsList);
    });
    // reckeck ports every 2s
    listPortsLoop = setInterval(function () {
        serialport.list(function (err, ports) {
            if (JSON.stringify(ports) != JSON.stringify(portsList)) {
                portsList = ports;
                io.sockets.emit('ports', ports);
                writeLog(chalk.yellow('Ports changed: ' + JSON.stringify(ports)), 1);
            }
        });
    }, 2000);

    if (isConnected) {
        appSocket.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
        if (port) {
            appSocket.emit('connectStatus', 'opened:' + port.path);
            appSocket.emit('activePort', port.path);
            appSocket.emit('activeBaudRate', port.options.baudRate);
        } else {
            appSocket.emit('connectStatus', 'opened:' + connectedTo);
            appSocket.emit('activeIP', connectedTo);
        }
        if (runningJob) {
            appSocket.emit('runningJob', runningJob);
        }
    } else {
        appSocket.emit('connectStatus', 'Connect');
    }

    appSocket.on('firstLoad', function () {
        writeLog(chalk.yellow('INFO: ') + chalk.blue('FirstLoad called'), 1);
        appSocket.emit('serverConfig', config);
        appSocket.emit('interfaces', supportedInterfaces);
        serialport.list(function (err, ports) {
            appSocket.emit('ports', ports);
        });
        if (isConnected) {
            appSocket.emit('activeInterface', connectionType);
            switch (connectionType) {
            case 'usb':
                appSocket.emit('activePort', port.path);
                appSocket.emit('activeBaudRate', port.options.baudRate);
                break;
            case 'telnet':
                appSocket.emit('activeIP', connectedTo);
                break;
            case 'esp8266':
                appSocket.emit('activeIP', connectedTo);
                break;
            }
            appSocket.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
            if (port) {
                appSocket.emit('connectStatus', 'opened:' + port.path);
            } else {
                appSocket.emit('connectStatus', 'opened:' + connectedTo);
            }
        } else {
            appSocket.emit('connectStatus', 'Connect');
        }
    });

    appSocket.on('getServerConfig', function () { // Deliver config of server (incl. versions)
        writeLog(chalk.yellow('INFO: ') + chalk.blue('Requesting Server Config '), 1);
        appSocket.emit('serverConfig', config);
    });

    appSocket.on('getInterfaces', function () { // Deliver supported Interfaces
        writeLog(chalk.yellow('INFO: ') + chalk.blue('Requesting Interfaces '), 1);
        appSocket.emit('interfaces', supportedInterfaces);
    });

    appSocket.on('getPorts', function () { // Refresh serial port list
        writeLog(chalk.yellow('INFO: ') + chalk.blue('Requesting Ports list '), 1);
        serialport.list(function (err, ports) {
            appSocket.emit('ports', ports);
        });
    });

    appSocket.on('getConnectStatus', function () { // Report active serial port to web-client
        writeLog(chalk.yellow('INFO: ') + chalk.blue('getConnectStatus'), 1);
        if (isConnected) {
            appSocket.emit('activeInterface', connectionType);
            switch (connectionType) {
            case 'usb':
                appSocket.emit('activePort', port.path);
                appSocket.emit('activeBaudRate', port.options.baudRate);
                break;
            case 'telnet':
                appSocket.emit('activeIP', connectedTo);
                break;
            case 'esp8266':
                appSocket.emit('activeIP', connectedTo);
                break;
            }
            appSocket.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
            if (port) {
                appSocket.emit('connectStatus', 'opened:' + port.path);
            } else {
                appSocket.emit('connectStatus', 'opened:' + connectedTo);
            }
        } else {
            appSocket.emit('connectStatus', 'Connect');
        }
    });

    appSocket.on('getFirmware', function (data) { // Deliver Firmware to Web-Client
        appSocket.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
    });

    appSocket.on('getRunningJob', function (data) { // Deliver running Job to Web-Client
        appSocket.emit('runningJob', runningJob);
    });

    appSocket.on('connectTo', function (data) { // If a user picks a port to connect to, open a Node SerialPort Instance to it
        data = data.split(',');
        writeLog(chalk.yellow('INFO: ') + chalk.blue('Connecting to ' + data), 1);
        if (!isConnected) {
            connectionType = data[0].toLowerCase();
            firmware = false;
            switch (connectionType) {
            case 'usb':
                port = new SerialPort(data[1], {
                    parser: serialport.parsers.readline('\n'),
                    baudrate: parseInt(data[2])
                });
                io.sockets.emit('connectStatus', 'opening:' + port.path);

                // Serial port events -----------------------------------------------
                port.on('open', function () {
                    io.sockets.emit('activePort', {port: port.path, baudrate: port.options.baudRate});
                    io.sockets.emit('connectStatus', 'opened:' + port.path);
                    //machineSend(String.fromCharCode(0x18)); // ctrl-x (needed for grbl-lpc)
                    machineSend('\n'); // this causes smoothie to send the welcome string
                    setTimeout(function () { //wait for controller to be ready
                        if (!firmware) { // Grbl should be allready detected
                            machineSend('version\n'); // Check if it's Smoothieware?
                            writeLog('Sent: version', 2);
                            setTimeout(function () {  // Wait for Smoothie to answer
                                if (!firmware) {     // If still not set
                                    machineSend('{fb:n}\n'); // Check if it's TinyG
                                    writeLog('Sent: {fb:n}', 2);
                                }
                            }, 500);
                        }
                    }, 500);
                    setTimeout(function () {
                        // Close port if we don't detect supported firmware after 2s.
                        if (!firmware) {
                            writeLog('No supported firmware detected. Closing port ' + port.path, 1);
                            io.sockets.emit('data', 'No supported firmware detected. Closing port ' + port.path);
                            io.sockets.emit('connectStatus', 'closing:' + port.path);
                            gcodeQueue.length = 0; // dump the queye
                            grblBufferSize.length = 0; // dump bufferSizes
                            tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
                            clearInterval(queueCounter);
                            clearInterval(statusLoop);
                            port.close();
                        }
                    }, 2000);
                    // machineSend("M115\n");    // Lets check if its Marlin?

                    writeLog(chalk.yellow('INFO: ') + 'Connected to ' + port.path + ' at ' + port.options.baudRate, 1);
                    isConnected = true;
                    connectedTo = port.path;

                    // Start interval for qCount messages to socket clients
//                        queueCounter = setInterval(function () {
//                            io.sockets.emit('qCount', gcodeQueue.length - queuePointer);
//                        }, 500);
                });

                port.on('close', function () { // open errors will be emitted as an error event
                    clearInterval(queueCounter);
                    clearInterval(statusLoop);
                    io.sockets.emit("connectStatus", 'closed:');
                    io.sockets.emit("connectStatus", 'Connect');
                    isConnected = false;
                    connectedTo = false;
                    firmware = false;
                    paused = false;
                    blocked = false;
                    writeLog(chalk.yellow('INFO: ') + chalk.blue('Port closed'), 1);
                });

                port.on('error', function (err) { // open errors will be emitted as an error event
                    writeLog(chalk.red('PORT ERROR: ') + chalk.blue(err.message), 1);
                    io.sockets.emit('error', err.message);
                    io.sockets.emit('connectStatus', 'closed:');
                    io.sockets.emit('connectStatus', 'Connect');
                });

                port.on('data', function (data) {
                    writeLog('Recv: ' + data, 3);
                    if (data.indexOf('ok') === 0) { // Got an OK so we are clear to send
                        if (firmware === 'grbl') {
                            grblBufferSize.shift();
                        }
                        blocked = false;
                        send1Q();
                    } else if (data.indexOf('<') === 0) { // Got statusReport (Grbl & Smoothieware)
                        var state = data.substring(1, data.search(/(,|\|)/));
                        //appSocket.emit('runStatus', state);
                        io.sockets.emit('data', data);

                        // Extract wPos
                        var startWPos = data.search(/wpos:/i) + 5;
                        var wPos;
                        if (startWPos > 5) {
                            wPos = data.replace('>', '').substr(startWPos).split(/,|\|/, 3);
                        }
                        if (Array.isArray(wPos)) {
                            var send = true;
                            if (xPos !== parseFloat(wPos[0]).toFixed(config.posDecimals)) {
                                xPos = parseFloat(wPos[0]).toFixed(config.posDecimals);
                                send = true;
                            }
                            if (yPos !== parseFloat(wPos[1]).toFixed(config.posDecimals)) {
                                yPos = parseFloat(wPos[1]).toFixed(config.posDecimals);
                                send = true;
                            }
                            if (zPos !== parseFloat(wPos[2]).toFixed(config.posDecimals)) {
                                zPos = parseFloat(wPos[2]).toFixed(config.posDecimals);
                                send = true;
                            }
                            if (send) {
                                io.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos});
                            }
                        }

//                            // Extract mPos
//                            var startMPos = data.search(/mpos:/i) + 5;
//                            var mPos;
//                            if (startMPos > 5) {
//                                mPos = data.replace('>', '').substr(startMPos).split(/,|\|/, 3);
//                            }
//                            if (Array.isArray(mPos)) {
//                                xPos = parseFloat(mPos[0]).toFixed(4);
//                                yPos = parseFloat(mPos[1]).toFixed(4);
//                                zPos = parseFloat(mPos[2]).toFixed(4);
//                                appSocket.emit('mPos', xPos + ',' + yPos + ',' + zPos);
//                            }

                        // Extract override values (for Grbl > v1.1 only!)
                        var startOv = data.search(/ov:/i) + 3;
                        if (startOv > 3) {
                            var ov = data.replace('>', '').substr(startOv).split(/,|\|/, 3);
                            if (Array.isArray(ov)) {
                                if (ov[0]) {
                                    io.sockets.emit('feedOverride', ov[0]);
                                }
                                if (ov[1]) {
                                    io.sockets.emit('rapidOverride', ov[1]);
                                }
                                if (ov[2]) {
                                    io.sockets.emit('spindleOverride', ov[2]);
                                }
                            }
                        }

                        // Extract realtime Feed and Spindle (for Grbl > v1.1 only!)
                        var startFS = data.search(/FS:/i) + 3;
                        if (startFS > 3) {
                            var fs = data.replace('>', '').substr(startFS).split(/,|\|/, 2);
                            if (Array.isArray(fs)) {
                                if (fs[0]) {
                                    io.sockets.emit('realFeed', fs[0]);
                                }
                                if (fs[1]) {
                                    io.sockets.emit('realSpindle', fs[1]);
                                }
                            }
                        }

                    } else if (data.indexOf('Grbl') === 0) { // Check if it's Grbl
                        firmware = 'grbl';
                        fVersion = data.substr(5, 4); // get version
                        fDate = '';
                        writeLog('GRBL detected (' + fVersion + ')', 1);
                        io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                        // Start intervall for status queries
                        statusLoop = setInterval(function () {
                            if (isConnected) {
                                machineSend('?');
                                //writeLog('Sent: ?', 2);
                            }
                        }, 250);
                    } else if (data.indexOf('LPC176') >= 0) { // LPC1768 or LPC1769 should be Smoothie
                        firmware = 'smoothie';
                        //SMOOTHIE_RX_BUFFER_SIZE = 64;  // max. length of one command line
                        var startPos = data.search(/version:/i) + 9;
                        fVersion = data.substr(startPos).split(/,/, 1);
                        startPos = data.search(/Build date:/i) + 12;
                        fDate = new Date(data.substr(startPos).split(/,/, 1));
                        var dateString = fDate.toDateString();
                        writeLog('Smoothieware detected (' + fVersion + ', ' + dateString + ')', 1);
                        io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                        // Start intervall for status queries
                        statusLoop = setInterval(function () {
                            if (isConnected) {
                                machineSend('?');
                                //writeLog('Sent: ?', 2);
                            }
                        }, 250);
                    } else if (data.indexOf('{') === 0) { // JSON response (probably TinyG)
                        var jsObject = JSON.parse(data);
                        if (jsObject.hasOwnProperty('r')) {
                            var footer = jsObject.f || (jsObject.r && jsObject.r.f);
                            var responseText;
                            if (footer !== undefined) {
                                if (footer[1] === 108) {
                                    responseText = util.format("TinyG reported an syntax error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]);
                                    io.sockets.emit('data', responseText);
                                    writeLog("Response: " + responseText + jsObject, 3);
                                } else if (footer[1] === 20) {
                                    responseText = util.format("TinyG reported an internal error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]);
                                    io.sockets.emit('data', responseText);
                                    writeLog("Response: " + responseText + jsObject, 3);
                                } else if (footer[1] === 202) {
                                    responseText = util.format("TinyG reported an TOO SHORT MOVE on line %d", jsObject.r.n);
                                    io.sockets.emit('data', responseText);
                                    writeLog("Response: " + responseText + jsObject, 3);
                                } else if (footer[1] === 204) {
                                    responseText = util.format("TinyG reported COMMAND REJECTED BY ALARM '%s'", JSON.stringify(jsObject.r));
                                    io.sockets.emit('data', responseText);
                                    writeLog("InAlarm: " + responseText + jsObject, 3);
                                } else if (footer[1] !== 0) {
                                    responseText = util.format("TinyG reported an error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]);
                                    io.sockets.emit('data', responseText);
                                    writeLog("Response: " + responseText + jsObject, 3);
                                } else {
                                    //io.sockets.emit('data', data);
                                }
                            }
                            //writeLog('Response: ' + JSON.stringify(jsObject.r) + ', ' + footer, 3);
                            jsObject = jsObject.r;

                            tinygBufferSize++;
                            blocked = false;
                            send1Q();
                        }
                        if (jsObject.hasOwnProperty('sr')) {    // status report
                            //writeLog('statusChanged ' + JSON.stringify(jsObject.sr), 3);
                            var send = false;
                            if (jsObject.sr.posx != null) {
                                xPos = parseFloat(jsObject.sr.posx).toFixed(config.posDecimals);
                                send = true;
                            }
                            if (jsObject.sr.posy != null) {
                                yPos = parseFloat(jsObject.sr.posy).toFixed(config.posDecimals);
                                send = true;
                            }
                            if (jsObject.sr.posz != null) {
                                zPos = parseFloat(jsObject.sr.posz).toFixed(config.posDecimals);
                                send = true;
                            }
                            if (send) {
                                io.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos});
                                //writeLog('wPos: ' + xPos + ', ' + yPos + ', ' + zPos, 3);
                            }
                            if (jsObject.sr.stat) {
                                var status = null;
                                switch (jsObject.sr.stat) {
                                    case 0:     // initializing
                                        status = 'Init';
                                        break;
                                    case 1:     // ready
                                        status = 'Idle';
                                        break;
                                    case 2:     // shutdown
                                        status = 'Alarm';
                                        break;
                                    case 3:     // stop
                                        status = 'Idle';
                                        break;
                                    case 4:     // end
                                        status = 'Idle';
                                        break;
                                    case 5:     // run
                                        status = 'Run';
                                        break;
                                    case 6:     // hold
                                        status = 'Hold';
                                        break;
                                    case 7:     // probe cycle
                                        status = 'Probe';
                                        break;
                                    case 8:     // running / cycling
                                        status = 'Run';
                                        break;
                                    case 9:     // homing
                                        status = 'Home';
                                        break;
                                }
                                if (status) {
                                    io.sockets.emit('data', '<' + status + ',>');
                                    //writeLog('Status: ' + status, 3);
                                }
                            }
                        }
                        if (jsObject.hasOwnProperty('fb')) {    // firmware
                            firmware = 'tinyg';
                            fVersion = jsObject.fb;
                            fDate = '';
                            writeLog('TinyG detected (' + fVersion + ')', 1);
                            io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                            // Start intervall for status queries
//                            statusLoop = setInterval(function () {
//                                if (isConnected) {
//                                    machineSend('{sr:n}\n');
//                                    //writeLog('Sent: {"sr":null}', 2);
//                                }
//                            }, 250);
                        }
                        if (jsObject.hasOwnProperty('gc')) {
                            writeLog('gcodeReceived ' + jsObject.r.gc, 3);
                            io.sockets.emit('data', data);
                        }
                        if (jsObject.hasOwnProperty('rx')) {
                            writeLog('rxReceived ' + jsObject.r.rx, 3);
                            io.sockets.emit('data', data);
                        }
                        if (jsObject.hasOwnProperty('er')) {
                            writeLog('errorReport ' + jsObject.er, 3);
                            io.sockets.emit('data', data);
                        }
                        //io.sockets.emit('data', data);
                    } else if (data.indexOf('ALARM') === 0) { //} || data.indexOf('HALTED') === 0) {
                        switch (firmware) {
                        case 'grbl':
                            var alarmCode = data.split(':')[1];
                            writeLog('ALARM:' + grblStrings.alarms(alarmCode));
                            io.sockets.emit('data', 'ALARM:' + grblStrings.alarms(alarmCode));
                            break;
                        case 'smoothie':
                            io.sockets.emit('data', data);
                            break;
                        case 'tinyg':
                            io.sockets.emit('data', data);
                            break;
                        }
//                        data = data.split(':');
//                        io.sockets.emit('alarm', data[1]);
//                        writeLog('Emptying Queue', 1);
//                        gcodeQueue.length = 0; // dump the queye
//                        grblBufferSize.length = 0; // dump bufferSizes
//                        tinygBufferSize = TINYG_RX_BUFFER_SIZE;
//                        writeLog('Clearing Lockout', 1);
//                        switch (firmware) {
//                        case 'grbl':
//                            machineSend('$X\n');
//                            blocked = false;
//                            paused = false;
//                            break;
//                        case 'smoothie':
//                            machineSend('$X\n'); //M999
//                            blocked = false;
//                            paused = false;
//                            break;
//                        case 'tinyg':
//                            machineSend('%'); // flush tinyg quere
//                            machineSend('~'); // resume
//                            blocked = false;
//                            paused = false;
//                            break;
//                        }
                    } else if (data.indexOf('error') === 0) { // Error received -> stay blocked stops queue
                        switch (firmware) {
                        case 'grbl':
                            grblBufferSize.shift();
                            var errorCode = data.split(':')[1];
                            writeLog('error:' + grblStrings.errors(errorCode));
                            io.sockets.emit('data', 'error:' + grblStrings.errors(errorCode));
                            break;
                        case 'smoothie':
                            io.sockets.emit('data', data);
                            break;
                        case 'tinyg':
                            io.sockets.emit('data', data);
                            break;
                        }
                    } else {
                        io.sockets.emit('data', data);
                    }
                });
                break;

            case 'telnet':  // Only supported by smoothieware!
                connectedIp = data[1];
                machineSocket = net.connect(23, connectedIp);
                io.sockets.emit('connectStatus', 'opening:' + connectedIp);

                // Telnet connection events -----------------------------------------------
                machineSocket.on('connect', function (prompt) {
                    io.sockets.emit('activeIP', connectedIp);
                    io.sockets.emit('connectStatus', 'opened:' + connectedIp);
                    writeLog(chalk.yellow('INFO: ') + chalk.blue('Telnet connected to ' + connectedIp), 1);
                    isConnected = true;
                    connectedTo = connectedIp;
                    machineSocket.write('version\n');

                    // Start intervall for status queries
//                    statusLoop = setInterval(function () {
//                        if (isConnected) {
//                            //machineSocket.write('get pos\n');
//                        } else {
//                            clearInterval(statusLoop);
//                            writeLog(chalk.yellow('WARN: ') + 'Unable to send gcode (not connected to Telnet)', 1);
//                        }
//                    }, 250);

                    setTimeout(function () {
                        // Close port if we don't detect supported firmware after 2s.
                        if (!firmware) {
                            writeLog('No supported firmware detected. Closing connection to ' + connectedTo, 1);
                            io.sockets.emit('data', 'No supported firmware detected. Closing connection to ' + connectedTo);
                            io.sockets.emit('connectStatus', 'closing:' + connectedTo);
                            gcodeQueue.length = 0; // dump the queye
                            grblBufferSize.length = 0; // dump bufferSizes
                            tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
                            clearInterval(queueCounter);
                            clearInterval(statusLoop);
                            machineSocket.destroy();
                        }
                    }, 2000);

                    // Start interval for qCount messages to appSocket clients
                    queueCounter = setInterval(function () {
                        io.sockets.emit('qCount', gcodeQueue.length);
                    }, 500);
                });

                machineSocket.on('timeout', function () {
                    writeLog(chalk.yellow('WARN: ') + chalk.blue('Telnet timeout!'), 1);
                    machineSocket.end();
                });

                machineSocket.on('close', function (e) {
                    clearInterval(queueCounter);
                    clearInterval(statusLoop);
                    io.sockets.emit("connectStatus", 'closed:');
                    io.sockets.emit("connectStatus", 'Connect');
                    isConnected = false;
                    connectedTo = false;
                    firmware = false;
                    paused = false;
                    blocked = false;
                    writeLog(chalk.yellow('INFO: ') + chalk.blue('Telnet connection closed'), 1);
                });

                machineSocket.on('error', function (e) {
                    io.sockets.emit("error", e.message);
                    writeLog(chalk.red('ERROR: ') + 'Telnet error: ' + e.message, 1);
                });

                machineSocket.on('data', function (response) {
                    //var bytes = new Uint8Array(data);
                    for (var i = 0; i < response.length; i++) {
                        if (response[i] != 0x0d) {
                            telnetBuffer += String.fromCharCode(response[i]);
                        }
                    }
                    var responseArray;
                    if (telnetBuffer.substr(-1) === '\n') {
                        responseArray = telnetBuffer.split('\n');
                        telnetBuffer = responseArray.pop();
                    } else {
                        responseArray = telnetBuffer.split('\n');
                        telnetBuffer = '';
                    }
                    var data = '';
                    while (responseArray.length > 0) {
                        data = responseArray.shift();
                        writeLog('Telnet: ' + data, 3);
                        if (data.indexOf('ok') === 0) { // Got an OK so we are clear to send
                            blocked = false;
                            send1Q();
                        } else if (data.indexOf('<') === 0) { // Got statusReport (Grbl & Smoothieware)
                            var state = data.substring(1, data.search(/(,|\|)/));
                            //appSocket.emit('runStatus', state);
                            io.sockets.emit('data', data);

                            // Extract wPos
                            var startWPos = data.search(/wpos:/i) + 5;
                            var wPos;
                            if (startWPos > 5) {
                                wPos = data.replace('>', '').substr(startWPos).split(/,|\|/, 3);
                            }
                            if (Array.isArray(wPos)) {
                                var send = true;
                                if (xPos !== parseFloat(wPos[0]).toFixed(config.posDecimals)) {
                                    xPos = parseFloat(wPos[0]).toFixed(config.posDecimals);
                                    send = true;
                                }
                                if (yPos !== parseFloat(wPos[1]).toFixed(config.posDecimals)) {
                                    yPos = parseFloat(wPos[1]).toFixed(config.posDecimals);
                                    send = true;
                                }
                                if (zPos !== parseFloat(wPos[2]).toFixed(config.posDecimals)) {
                                    zPos = parseFloat(wPos[2]).toFixed(config.posDecimals);
                                    send = true;
                                }
                                if (send) {
                                    io.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos});
                                }
                            }

                            // Extract override values (for Grbl > v1.1 only!)
                            var startOv = data.search(/ov:/i) + 3;
                            if (startOv > 3) {
                                var ov = data.replace('>', '').substr(startOv).split(/,|\|/, 3);
                                if (Array.isArray(ov)) {
                                    if (ov[0]) {
                                        io.sockets.emit('feedOverride', ov[0]);
                                    }
                                    if (ov[1]) {
                                        io.sockets.emit('rapidOverride', ov[1]);
                                    }
                                    if (ov[2]) {
                                        io.sockets.emit('spindleOverride', ov[2]);
                                    }
                                }
                            }

                            // Extract realtime Feed and Spindle (for Grbl > v1.1 only!)
                            var startFS = data.search(/FS:/i) + 3;
                            if (startFS > 3) {
                                var fs = data.replace('>', '').substr(startFS).split(/,|\|/, 2);
                                if (Array.isArray(fs)) {
                                    if (fs[0]) {
                                        io.sockets.emit('realFeed', fs[0]);
                                    }
                                    if (fs[1]) {
                                        io.sockets.emit('realSpindle', fs[1]);
                                    }
                                }
                            }
                        } else if (data.indexOf('Grbl') === 0) { // Check if it's Grbl
                            firmware = 'grbl';
                            fVersion = data.substr(5, 4); // get version
                            fDate = '';
                            writeLog('GRBL detected (' + fVersion + ')', 1);
                            io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                            // Start intervall for status queries
                            statusLoop = setInterval(function () {
                                if (isConnected) {
                                    machineSend('?');
                                    //writeLog('Sent: ?', 2);
                                }
                            }, 250);
                        } else if (data.indexOf('LPC176') >= 0) { // LPC1768 or LPC1769 should be Smoothie
                            firmware = 'smoothie';
                            //SMOOTHIE_RX_BUFFER_SIZE = 64;  // max. length of one command line
                            var startPos = data.search(/version:/i) + 9;
                            fVersion = data.substr(startPos).split(/,/, 1);
                            startPos = data.search(/Build date:/i) + 12;
                            fDate = new Date(data.substr(startPos).split(/,/, 1));
                            var dateString = fDate.toDateString();
                            writeLog('Smoothieware detected (' + fVersion + ', ' + dateString + ')', 1);
                            io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                            // Start intervall for status queries
                            statusLoop = setInterval(function () {
                                if (isConnected) {
                                    machineSend('get status\n');
                                }
                            }, 250);
                        } else if (data.indexOf('WCS:') >= 0) {
                            //console.log('Telnet:', response);
                            // IN: "last C: X:0.0000 Y:-0.0000 Z:0.0000 realtime WCS: X:0.0000 Y:0.0045 Z:0.0000 MCS: X:44.2000 Y:76.5125 Z:0.0000 APOS: X:44.2000 Y:76.5125 Z:0.0000 MP: X:44.2000 Y:76.5080 Z:0.0000 CMP: X:44.2000 Y:76.5080 Z:0.0000"
                            // OUT: "<Run,MPos:49.5756,279.7644,-15.0000,WPos:0.0000,0.0000,0.0000>"
                            var startPos = data.search(/wcs: /i) + 5;
                            var wpos;
                            if (startPos > 5) {
                                wpos = data.substr(startPos).split(/:| /, 6);
                            }
                            if (Array.isArray(wpos)) {
                                var wxpos = parseFloat(wpos[1]).toFixed(2);
                                var wypos = parseFloat(wpos[3]).toFixed(2);
                                var wzpos = parseFloat(wpos[5]).toFixed(2);
                                var wpos = wxpos + ',' + wypos + ',' + wzpos;
                                writeLog('Telnet: ' + 'WPos:' + wpos, 1);
                                io.sockets.emit('wPos', {x: wxpos, y: wypos, z: wzpos});
                            }
                        } else if (data.indexOf('MCS:') >= 0) {
                            //console.log('Telnet:', response);
                            // IN: "last C: X:0.0000 Y:-0.0000 Z:0.0000 realtime WCS: X:0.0000 Y:0.0045 Z:0.0000 MCS: X:44.2000 Y:76.5125 Z:0.0000 APOS: X:44.2000 Y:76.5125 Z:0.0000 MP: X:44.2000 Y:76.5080 Z:0.0000 CMP: X:44.2000 Y:76.5080 Z:0.0000"
                            // OUT: "<Run,MPos:49.5756,279.7644,-15.0000,WPos:0.0000,0.0000,0.0000>"
                            var startPos = data.search(/mcs: /i) + 5;
                            var mpos;
                            if (startPos > 5) {
                                mpos = data.substr(startPos).split(/:| /, 6);
                            }
                            if (Array.isArray(wpos)) {
                                var mxpos = parseFloat(mpos[1]).toFixed(2);
                                var mypos = parseFloat(mpos[3]).toFixed(2);
                                var mzpos = parseFloat(mpos[5]).toFixed(2);
                                var mpos = mxpos + ',' + mypos + ',' + mzpos;
                                writeLog('Telnet: ' + 'MPos:' + mpos, 1);
                                io.sockets.emit('mPos', {x: mxpos, y: mypos, z: mzpos});
                            }
                        } else if (data.indexOf('ALARM') === 0) { //} || data.indexOf('HALTED') === 0) {
                            switch (firmware) {
                            case 'grbl':
                                var alarmCode = data.split(':')[1];
                                writeLog('ALARM:' + grblStrings.alarms(alarmCode));
                                io.sockets.emit('data', 'ALARM:' + grblStrings.alarms(alarmCode));
                                break;
                            case 'smoothie':
                                io.sockets.emit('data', data);
                                break;
                            case 'tinyg':
                                io.sockets.emit('data', data);
                                break;
                            }
                        } else if (data.indexOf('error') === 0) { // Error received -> stay blocked stops queue
                            switch (firmware) {
                            case 'grbl':
                                grblBufferSize.shift();
                                var errorCode = data.split(':')[1];
                                writeLog('error:' + grblStrings.errors(errorCode));
                                io.sockets.emit('data', 'error:' + grblStrings.errors(errorCode));
                                break;
                            case 'smoothie':
                                io.sockets.emit('data', data);
                                break;
                            case 'tinyg':
                                io.sockets.emit('data', data);
                                break;
                            }
                        //} else if (data.indexOf('last C') === 0) {
                        //} else if (data.indexOf('WPos') === 0) {
                        //} else if (data.indexOf('APOS') === 0) {
                        //} else if (data.indexOf('MP') === 0) {
                        //} else if (data.indexOf('CMP') === 0) {
                        } else {
                            io.sockets.emit('data', data);
                        }
                    }
                });
                break;

            case 'esp8266':
                connectedIp = data[1];
                machineSocket = new WebSocket('ws://'+connectedIp+'/'); // connect to ESP websocket
                io.sockets.emit('connectStatus', 'opening:' + connectedIp);

                // ESP socket evnets -----------------------------------------------
                machineSocket.on('open', function (e) {
                    io.sockets.emit('activeIP', connectedIp);
                    io.sockets.emit('connectStatus', 'opened:' + connectedIp);
                    writeLog(chalk.yellow('INFO: ') + chalk.blue('ESP connected @ ' + connectedIp), 1);
                    isConnected = true;
                    connectedTo = connectedIp;
                    //machineSend(String.fromCharCode(0x18));

                    setTimeout(function() { //wait for controller to be ready
                        if (!firmware) { // Grbl should be allready detected
                            machineSend('version\n'); // Check if it's Smoothieware?
                            writeLog('Sent: version', 2);
                            setTimeout(function () {  // Wait for Smoothie to answer
                                if (!firmware) {     // If still not set
                                    machineSend('$fb\n'); // Check if it's TinyG
                                    writeLog('Sent: $fb', 2);
                                }
                            }, 500);
                        }
                    }, 500);
                    // machineSend("M115\n");    // Lets check if its Marlin?

                    setTimeout(function () {
                        // Close port if we don't detect supported firmware after 2s.
                        if (!firmware) {
                            writeLog('No supported firmware detected. Closing connection to ' + connectedTo, 1);
                            io.sockets.emit('data', 'No supported firmware detected. Closing connection to ' + connectedTo);
                            io.sockets.emit('connectStatus', 'closing:' + connectedTo);
                            gcodeQueue.length = 0; // dump the queye
                            grblBufferSize.length = 0; // dump bufferSizes
                            tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
                            clearInterval(queueCounter);
                            clearInterval(statusLoop);
                            machineSocket.close();
                        }
                    }, 2000);

                });

                machineSocket.on('close', function (e) {
                    clearInterval(queueCounter);
                    clearInterval(statusLoop);
                    io.sockets.emit("connectStatus", 'closed:');
                    io.sockets.emit("connectStatus", 'Connect');
                    isConnected = false;
                    connectedTo = false;
                    firmware = false;
                    paused = false;
                    blocked = false;
                    writeLog(chalk.yellow('INFO: ') + chalk.blue('ESP connection closed'), 1);
                });

                machineSocket.on('error', function (e) {
                    io.sockets.emit('error', e.message);
                    io.sockets.emit('connectStatus', 'closed:');
                    io.sockets.emit('connectStatus', 'Connect');
                    writeLog(chalk.red('ESP ERROR: ') + chalk.blue(e.message), 1);
                });

                machineSocket.on('message', function (msg) {
                    espBuffer += msg;
                    var split = espBuffer.split(/\n/);
                    espBuffer = split.pop();
                    for (var i = 0; i < split.length; i++) {
                        var data = split[i];
                        if (data.length > 0) {
                            writeLog('Recv: ' + data, 3);
                            if (data.indexOf('ok') === 0) { // Got an OK so we are clear to send
                                if (firmware === 'grbl') {
                                    grblBufferSize.shift();
                                }
                                blocked = false;
                                send1Q();
                            } else if (data.indexOf('<') === 0) { // Got statusReport (Grbl & Smoothieware)
                                var state = data.substring(1, data.search(/(,|\|)/));
                                //appSocket.emit('runStatus', state);
                                io.sockets.emit('data', data);

                                // Extract wPos
                                var startWPos = data.search(/wpos:/i) + 5;
                                var wPos;
                                if (startWPos > 5) {
                                    wPos = data.replace('>', '').substr(startWPos).split(/,|\|/, 3);
                                }
                                if (Array.isArray(wPos)) {
                                    var send = true;
                                    if (xPos !== parseFloat(wPos[0]).toFixed(4)) {
                                        xPos = parseFloat(wPos[0]).toFixed(4);
                                        send = true;
                                    }
                                    if (yPos !== parseFloat(wPos[1]).toFixed(4)) {
                                        yPos = parseFloat(wPos[1]).toFixed(4);
                                        send = true;
                                    }
                                    if (zPos !== parseFloat(wPos[2]).toFixed(4)) {
                                        zPos = parseFloat(wPos[2]).toFixed(4);
                                        send = true;
                                    }
                                    if (send) {
                                        io.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos});
                                    }
                                }
                                // Extract override values (for Grbl > v1.1 only!)
                                var startOv = data.search(/ov:/i) + 3;
                                if (startOv > 3) {
                                    var ov = data.replace('>', '').substr(startOv).split(/,|\|/, 3);
                                    if (Array.isArray(ov)) {
                                        if (ov[0]) {
                                            io.sockets.emit('feedOverride', ov[0]);
                                        }
                                        if (ov[1]) {
                                            io.sockets.emit('rapidOverride', ov[1]);
                                        }
                                        if (ov[2]) {
                                            io.sockets.emit('spindleOverride', ov[2]);
                                        }
                                    }
                                }
                                // Extract realtime Feed and Spindle (for Grbl > v1.1 only!)
                                var startFS = data.search(/FS:/i) + 3;
                                if (startFS > 3) {
                                    var fs = data.replace('>', '').substr(startFS).split(/,|\|/, 2);
                                    if (Array.isArray(fs)) {
                                        if (fs[0]) {
                                            io.sockets.emit('realFeed', fs[0]);
                                        }
                                        if (fs[1]) {
                                            io.sockets.emit('realSpindle', fs[1]);
                                        }
                                    }
                                }
                            } else if (data.indexOf('Grbl') === 0) { // Check if it's Grbl
                                firmware = 'grbl';
                                fVersion = data.substr(5, 4); // get version
                                fDate = '';
                                writeLog('GRBL detected (' + fVersion + ')', 1);
                                io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                                // Start intervall for status queries
                                statusLoop = setInterval(function () {
                                    if (isConnected) {
                                        machineSend('?');
                                    }
                                }, 250);
                            } else if (data.indexOf('Smoothie') >= 0) { // Check if we got smoothie welcome message
                                firmware = 'smoothie';
                                writeLog('Smoothieware detected, asking for version', 2);
                            } else if (data.indexOf('LPC176') >= 0) { // LPC1768 or LPC1769 should be Smoothie
                                firmware = 'smoothie';
                                //SMOOTHIE_RX_BUFFER_SIZE = 64;  // max. length of one command line
                                var startPos = data.search(/version:/i) + 9;
                                fVersion = data.substr(startPos).split(/,/, 1);
                                startPos = data.search(/Build date:/i) + 12;
                                fDate = new Date(data.substr(startPos).split(/,/, 1));
                                var dateString = fDate.toDateString();
                                writeLog('Smoothieware detected (' + fVersion + ', ' + dateString + ')', 1);
                                io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                                // Start intervall for status queries
                                statusLoop = setInterval(function () {
                                    if (isConnected) {
                                        machineSend('?');
                                    }
                                }, 250);
                            } else if (data.indexOf('{') === 0) { // JSON response (probably TinyG)
                                var jsObject = JSON.parse(data);
                                if (jsObject.hasOwnProperty('r')) {
                                    var footer = jsObject.f || (jsObject.r && jsObject.r.f);
                                    if (footer !== undefined) {
                                        if (footer[1] === 108) {
                                            writeLog(
                                                "Response: " +
                                                util.format("TinyG reported an syntax error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]) +
                                                jsObject, 3
                                            );
                                        } else if (footer[1] === 20) {
                                            writeLog(
                                                "Response: " +
                                                util.format("TinyG reported an internal error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]) +
                                                jsObject, 3
                                            );
                                        } else if (footer[1] === 202) {
                                            writeLog(
                                                "Response: " +
                                                util.format("TinyG reported an TOO SHORT MOVE on line %d", jsObject.r.n) +
                                                jsObject, 3
                                            );
                                        } else if (footer[1] === 204) {
                                            writeLog(
                                                "InAlarm: " +
                                                util.format("TinyG reported COMMAND REJECTED BY ALARM '%s'", JSON.stringify(jsObject.r)) +
                                                jsObject, 3
                                            );
                                        } else if (footer[1] !== 0) {
                                            writeLog(
                                                "Response: " +
                                                util.format("TinyG reported an error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]) +
                                                jsObject, 3
                                            );
                                        }
                                    }

                                    writeLog('Response: ' + jsObject.r + footer, 3);

                                    jsObject = jsObject.r;

                                    tinygBufferSize++;
                                    blocked = false;
                                    send1Q();
                                }

                                if (jsObject.hasOwnProperty('er')) {
                                    writeLog('errorReport ' + jsObject.er, 3);
                                }
                                if (jsObject.hasOwnProperty('sr')) {
                                    writeLog('statusChanged ' + jsObject.sr, 3);
                                    var jsObject = JSON.parse(data);
                                    if (jsObject.sr.posx) {
                                        xPos = parseFloat(jsObject.sr.posx).toFixed(4);
                                    }
                                    if (jsObject.sr.posy) {
                                        yPos = parseFloat(jsObject.sr.posy).toFixed(4);
                                    }
                                    if (jsObject.sr.posz) {
                                        zPos = parseFloat(jsObject.sr.posz).toFixed(4);
                                    }
                                    io.sockets.emit('wPos', xPos + ',' + yPos + ',' + zPos);
                                }
                                if (jsObject.hasOwnProperty('gc')) {
                                    writeLog('gcodeReceived ' + jsObject.gc, 3);
                                }
                                if (jsObject.hasOwnProperty('rx')) {
                                    writeLog('rxReceived ' + jsObject.rx, 3);
                                }
                                if (jsObject.hasOwnProperty('fb')) { // TinyG detected
                                    firmware = 'tinyg';
                                    fVersion = jsObject.fb;
                                    fDate = '';
                                    writeLog('TinyG detected (' + fVersion + ')', 1);
                                    io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                                    // Start intervall for status queries
                                    statusLoop = setInterval(function () {
                                        if (isConnected) {
                                            machineSend('{"sr":null}\n');
                                            writeLog('Sent: {"sr":null}', 2);
                                        }
                                    }, 250);
                                }
                            } else if (data.indexOf('ALARM') === 0) { //} || data.indexOf('HALTED') === 0) {
                                switch (firmware) {
                                case 'grbl':
                                    var alarmCode = data.split(':')[1];
                                    writeLog('ALARM:' + grblStrings.alarms(alarmCode));
                                    io.sockets.emit('data', 'ALARM:' + grblStrings.alarms(alarmCode));
                                    break;
                                case 'smoothie':
                                    io.sockets.emit('data', data);
                                    break;
                                case 'tinyg':
                                    io.sockets.emit('data', data);
                                    break;
                                }
                            } else if (data.indexOf('error') === 0) { // Error received -> stay blocked stops queue
                                switch (firmware) {
                                case 'grbl':
                                    grblBufferSize.shift();
                                    var errorCode = data.split(':')[1];
                                    writeLog('error:' + grblStrings.errors(errorCode));
                                    io.sockets.emit('data', 'error:' + grblStrings.errors(errorCode));
                                    break;
                                case 'smoothie':
                                    io.sockets.emit('data', data);
                                    break;
                                case 'tinyg':
                                    io.sockets.emit('data', data);
                                    break;
                                }
                            } else {
                                io.sockets.emit('data', data);
                            }
                        }
                    }
                });
                break;
            }
        } else {
            switch (connectionType) {
            case 'usb':
                io.sockets.emit("connectStatus", 'opened:' + port.path);
                break;
            case 'telnet':
                io.sockets.emit("connectStatus", 'opened:' + connectedIp);
                break;
            case 'esp8266':
                io.sockets.emit("connectStatus", 'opened:' + connectedIp);
                break;
            }
        }
    });

    appSocket.on('runJob', function (data) {
        writeLog('Run Job (' + data.length + ')', 1);
        if (isConnected) {
            if (data) {
                runningJob = data;
                data = data.split('\n');
                for (var i = 0; i < data.length; i++) {
                    var line = data[i].split(';'); // Remove everything after ; = comment
                    var tosend = line[0].trim();
                    if (tosend.length > 0) {
                        if (optimizeGcode) {
                            var newMode;
                            if (tosend.indexOf('G0') === 0) {
                                tosend = tosend.replace(/\s+/g, '');
                                newMode = 'G0';
                            } else if (tosend.indexOf('G1') === 0) {
                                tosend = tosend.replace(/\s+/g, '');
                                newMode = 'G1';
                            } else if (tosend.indexOf('G2') === 0) {
                                tosend = tosend.replace(/\s+/g, '');
                                newMode = 'G2';
                            } else if (tosend.indexOf('G3') === 0) {
                                tosend = tosend.replace(/\s+/g, '');
                                newMode = 'G3';
                            } else if (tosend.indexOf('X') === 0) {
                                tosend = tosend.replace(/\s+/g, '');
                            } else if (tosend.indexOf('Y') === 0) {
                                tosend = tosend.replace(/\s+/g, '');
                            } else if (tosend.indexOf('Z') === 0) {
                                tosend = tosend.replace(/\s+/g, '');
                            }
                            if (newMode) {
                                if (newMode === lastMode) {
                                    tosend.substr(2);
                                } else {
                                    lastMode = newMode;
                                }
                            }
                        }
                        //console.log(line);
                        addQ(tosend);
                    }
                }
                if (i > 0) {
                    startTime = new Date(Date.now());
                    // Start interval for qCount messages to socket clients
                    queueCounter = setInterval(function () {
                        io.sockets.emit('qCount', gcodeQueue.length - queuePointer);
                    }, 500);
                    io.sockets.emit('runStatus', 'running');
                    send1Q();
                }
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('runCommand', function (data) {
        writeLog(chalk.red('Run Command (' + data.replace('\n', '|') + ')'), 1);
        if (isConnected) {
            if (data) {
                data = data.split('\n');
                for (var i = 0; i < data.length; i++) {
                    var line = data[i].split(';'); // Remove everything after ; = comment
                    var tosend = line[0].trim();
                    if (tosend.length > 0) {
                        addQ(tosend);
                    }
                }
                if (i > 0) {
                    //io.sockets.emit('runStatus', 'running');
                    send1Q();
                }
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('jog', function (data) {
        writeLog(chalk.red('Jog ' + data), 1);
        if (isConnected) {
            data = data.split(',');
            var dir = data[0];
            var dist = parseFloat(data[1]);
            var feed;
            if (data.length > 2) {
                feed = parseInt(data[2]);
                if (feed) {
                    feed = 'F' + feed;
                }
            }
            if (dir && dist && feed) {
                writeLog('Adding jog commands to queue. blocked=' + blocked + ', paused=' + paused + ', Q=' + gcodeQueue.length);
                switch (firmware) {
                case 'grbl':
                    addQ('$J=G91' + dir + dist + feed);
                    send1Q();
                    break;
                case 'smoothie':
                    addQ('G91');
                    addQ('G0' + feed + dir + dist);
                    addQ('G90');
                    send1Q();
                    break;
                case 'tinyg':
                    addQ('G91');
                    addQ('G0' + feed + dir + dist);
                    addQ('G90');
                    send1Q();
                    break;
                default:
                    writeLog(chalk.red('ERROR: ') + chalk.blue('Unknown firmware!'), 1);
                    break;
                }
            } else {
                writeLog(chalk.red('ERROR: ') + chalk.blue('Invalid params!'), 1);    
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('jogTo', function (data) {     // data = {x:xVal, y:yVal, z:zVal, mode:0(absulute)|1(relative), feed:fVal}
        writeLog(chalk.red('JogTo ' + JSON.stringify(data)), 1);
        if (isConnected) {
            if (data.x !== undefined || data.y !== undefined || data.z !== undefined) {
                var xVal = (data.x !== undefined ? 'X' + parseFloat(data.x) : '');
                var yVal = (data.y !== undefined ? 'Y' + parseFloat(data.y) : '');
                var zVal = (data.z !== undefined ? 'Z' + parseFloat(data.z) : '');
                var mode = ((data.mode == 0) ? 0 : 1);
                var feed = (data.feed !== undefined ? 'F' + parseInt(data.feed) : '');
                writeLog('Adding jog commands to queue. blocked=' + blocked + ', paused=' + paused + ', Q=' + gcodeQueue.length);
                switch (firmware) {
                case 'grbl':
                    addQ('$J=G9' + mode + xVal + yVal + zVal + feed);
                    send1Q();
                    break;
                case 'smoothie':
                    addQ('G9' + mode);
                    addQ('G0' + feed + xVal + yVal + zVal);
                    addQ('G90');
                    send1Q();
                    break;
                case 'tinyg':
                    addQ('G9' + mode);
                    addQ('G0' + feed + xVal + yVal + zVal);
                    addQ('G90');
                    send1Q();
                    break;
                default:
                    writeLog(chalk.red('ERROR: ') + chalk.blue('Unknown firmware!'), 1);
                    break;
                }
            } else {
                writeLog(chalk.red('error') + chalk.blue('Invalid params!'), 1);    
                io.sockets.emit('data', 'Invalid jogTo() params!');
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('setZero', function (data) {
        writeLog(chalk.red('setZero(' + data + ')'), 1);
        if (isConnected) {
            switch (data) {
            case 'x':
                addQ('G10 L20 P0﻿ X0');
                break;
            case 'y':
                addQ('G10 L20 P0﻿ Y0');
                break;
            case 'z':
                addQ('G10 L20 P0﻿ Z0');
                break;
            case 'all':
                addQ('G10 L20 P0﻿ X0 Y0 Z0');
                break;
            }
            send1Q();
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('gotoZero', function (data) {
        writeLog(chalk.red('gotoZero(' + data + ')'), 1);
        if (isConnected) {
            switch (data) {
            case 'x':
                addQ('G0 X0');
                break;
            case 'y':
                addQ('G0 Y0');
                break;
            case 'z':
                addQ('G0 Z0');
                break;
            case 'all':
                addQ('G0 X0 Y0 Z0');
                break;
            }
            send1Q();
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('feedOverride', function (data) {
        if (isConnected) {
            switch (firmware) {
            case 'grbl':
                var code;
                switch (data) {
                case 0:
                    code = 144; // set to 100%
                    data = '100';
                    break;
                case 10:
                    code = 145; // +10%
                    data = '+' + data;
                    break;
                case -10:
                    code = 146; // -10%
                    break;
                case 1:
                    code = 147; // +1%
                    data = '+' + data;
                    break;
                case -1:
                    code = 148; // -1%
                    break;
                }
                if (code) {
                    //jumpQ(String.fromCharCode(parseInt(code)));
                    machineSend(String.fromCharCode(parseInt(code)));
                    writeLog('Sent: Code(' + code + ')', 2);
                    writeLog(chalk.red('Feed Override ' + data + '%'), 1);
                }
                break;
            case 'smoothie':
                if (data === 0) {
                    feedOverride = 100;
                } else {
                    if ((feedOverride + data <= 200) && (feedOverride + data >= 10)) {
                        // valid range is 10..200, else ignore!
                        feedOverride += data;
                    }
                }
                //jumpQ('M220S' + feedOverride);
                machineSend('M220S' + feedOverride + '\n');
                writeLog('Sent: M220S' + feedOverride, 2);
                io.sockets.emit('feedOverride', feedOverride);
                writeLog(chalk.red('Feed Override ' + feedOverride.toString() + '%'), 1);
                //send1Q();
                break;
            case 'tinyg':
                break;
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('spindleOverride', function (data) {
        if (isConnected) {
            switch (firmware) {
            case 'grbl':
                var code;
                switch (data) {
                case 0:
                    code = 153; // set to 100%
                    data = '100';
                    break;
                case 10:
                    code = 154; // +10%
                    data = '+' + data;
                    break;
                case -10:
                    code = 155; // -10%
                    break;
                case 1:
                    code = 156; // +1%
                    data = '+' + data;
                    break;
                case -1:
                    code = 157; // -1%
                    break;
                }
                if (code) {
                    //jumpQ(String.fromCharCode(parseInt(code)));
                    machineSend(String.fromCharCode(parseInt(code)));
                    writeLog('Sent: Code(' + code + ')', 2);
                    writeLog(chalk.red('Spindle (Laser) Override ' + data + '%'), 1);
                }
                break;
            case 'smoothie':
                if (data === 0) {
                    spindleOverride = 100;
                } else {
                    if ((spindleOverride + data <= 200) && (spindleOverride + data >= 0)) {
                        // valid range is 0..200, else ignore!
                        spindleOverride += data;
                    }
                }
                //jumpQ('M221S' + spindleOverride);
                machineSend('M221S' + spindleOverride + '\n');
                writeLog('Sent: M221S' + spindleOverride, 2);
                io.sockets.emit('spindleOverride', spindleOverride);
                writeLog(chalk.red('Spindle (Laser) Override ' + spindleOverride.toString() + '%'), 1);
                //send1Q();
                break;
            case 'tinyg':
                break;
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('laserTest', function (data) { // Laser Test Fire
        if (isConnected) {
            data = data.split(',');
            var power = parseFloat(data[0]);
            var duration = parseInt(data[1]);
            var maxS = parseFloat(data[2]);
            if (power > 0) {
                if (!laserTestOn) {
                    // laserTest is off
                    writeLog('laserTest: ' + 'Power ' + power + ', Duration ' + duration + ', maxS ' + maxS, 1);
                    if (duration >= 0) {
                        switch (firmware) {
                        case 'grbl':
                            addQ('G1F1');
                            addQ('M3S' + parseInt(power * maxS / 100));
                            laserTestOn = true;
                            appSocket.emit('laserTest', power);
                            if (duration > 0) {
                                addQ('G4 P' + duration / 1000);
                                addQ('M5S0');
                                laserTestOn = false;
                                //appSocket.emit('laserTest', 0); //-> Grbl get the real state with status report
                            }
                            send1Q();
                            break;
                        case 'smoothie':
                            addQ('M3\n');
                            addQ('fire ' + power + '\n');
                            laserTestOn = true;
                            appSocket.emit('laserTest', power);
                            if (duration > 0) {
                                var divider = 1;
                                if (fDate >= new Date('2017-01-02')) {
                                    divider = 1000;
                                }
                                addQ('G4P' + duration / divider + '\n');
                                addQ('fire off\n');
                                addQ('M5');
                                setTimeout(function () {
                                    laserTestOn = false;
                                    appSocket.emit('laserTest', 0);
                                }, duration );
                            }
                            send1Q();
                            break;
                        case 'tinyg':
                            addQ('G1F1');
                            addQ('M3S' + parseInt(power * maxS / 100));
                            laserTestOn = true;
                            appSocket.emit('laserTest', power);
                            if (duration > 0) {
                                addQ('G4 P' + duration / 1000);
                                addQ('M5S0');
                                laserTestOn = false;
                                setTimeout(function () {
                                    laserTestOn = false;
                                    appSocket.emit('laserTest', 0);
                                }, duration );
                            }
                            send1Q();
                            break;
                        }
                    }
                } else {
                    writeLog('laserTest: ' + 'Power off', 1);
                    switch (firmware) {
                    case 'grbl':
                        addQ('M5S0');
                        send1Q();
                        break;
                    case 'smoothie':
                        addQ('fire off\n');
                        addQ('M5\n');
                        send1Q();
                        break;
                    case 'tinyg':
                        addQ('M5S0');
                        send1Q();
                        break;
                    }
                    laserTestOn = false;
                    appSocket.emit('laserTest', 0);
                }
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('pause', function () {
        if (isConnected) {
            paused = true;
            writeLog(chalk.red('PAUSE'), 1);
            switch (firmware) {
            case 'grbl':
                machineSend('!'); // Send hold command
                writeLog('Sent: !', 2);
                if (fVersion === '1.1d') {
                    machineSend(String.fromCharCode(0x9E)); // Stop Spindle/Laser
                    writeLog('Sent: Code(0x9E)', 2);
                }
                break;
            case 'smoothie':
                machineSend('!'); // Laser will be turned off by smoothie (in default config!)
                //machineSend('M600\n'); // Laser will be turned off by smoothie (in default config!)
                writeLog('Sent: !', 2);
                break;
            case 'tinyg':
                machineSend('!'); // Send hold command
                writeLog('Sent: !', 2);
                break;
            }
            io.sockets.emit('runStatus', 'paused');
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('resume', function () {
        if (isConnected) {
            writeLog(chalk.red('UNPAUSE'), 1);
            //io.sockets.emit('connectStatus', 'unpaused:' + port.path);
            switch (firmware) {
            case 'grbl':
                machineSend('~'); // Send resume command
                writeLog('Sent: ~', 2);
                break;
            case 'smoothie':
                machineSend('~'); // Send resume command
                //machineSend('M601\n');
                writeLog('Sent: ~', 2);
                break;
            case 'tinyg':
                machineSend('~'); // Send resume command
                writeLog('Sent: ~', 2);
                break;
            }
            paused = false;
            send1Q(); // restart queue
            io.sockets.emit('runStatus', 'resumed');
//            switch (connectionType) {
//            case 'usb':
//                io.sockets.emit("connectStatus", 'opened:' + port.path);
//                break;
//            case 'telnet':
//                io.sockets.emit("connectStatus", 'opened:' + connectedIp);
//                break;
//            case 'esp8266':
//                io.sockets.emit("connectStatus", 'opened:' + connectedIp);
//                break;
//            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('stop', function () {
        if (isConnected) {
            paused = true;
            writeLog(chalk.red('STOP'), 1);
            switch (firmware) {
            case 'grbl':
                machineSend('!'); // hold
                writeLog('Sent: !', 2);
                if (fVersion === '1.1d') {
                    machineSend(String.fromCharCode(0x9E)); // Stop Spindle/Laser
                    writeLog('Sent: Code(0x9E)', 2);
                }
                writeLog('Cleaning Queue', 1);
                gcodeQueue.length = 0; // Dump the Queye
                grblBufferSize.length = 0; // Dump bufferSizes
                tinygBufferSize = TINYG_RX_BUFFER_SIZE;  // reset tinygBufferSize
                queueLen = 0;
                queuePointer = 0;
                queuePos = 0;
                startTime = null;
                machineSend(String.fromCharCode(0x18)); // ctrl-x
                writeLog('Sent: Code(0x18)', 2);
                blocked = false;
                paused = false;
                break;
            case 'smoothie':
                paused = true;
                machineSend(String.fromCharCode(0x18)); // ctrl-x
                writeLog('Sent: Code(0x18)', 2);
                break;
            case 'tinyg':
                paused = true;
                machineSend('!'); // hold
                writeLog('Sent: !', 2);
                machineSend('%'); // dump TinyG queue
                writeLog('Sent: %', 2);
                break;
            }
            clearInterval(queueCounter);
            io.sockets.emit('qCount', 0);
            gcodeQueue.length = 0; // Dump the Queye
            grblBufferSize.length = 0; // Dump bufferSizes
            tinygBufferSize = TINYG_RX_BUFFER_SIZE;  // reset tinygBufferSize
            queueLen = 0;
            queuePointer = 0;
            queuePos = 0;
            laserTestOn = false;
            startTime = null;
            runningJob = null;
            blocked = false;
            paused = false;
            io.sockets.emit('runStatus', 'stopped');
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('clearAlarm', function (data) { // Clear Alarm
        if (isConnected) {
            data = parseInt(data);
            writeLog('Clearing Queue: Method ' + data, 1);
            switch (data) {
            case 1:
                writeLog('Clearing Lockout');
                switch (firmware) {
                case 'grbl':
                    machineSend('$X\n');
                    writeLog('Sent: $X', 2);
                    break;
                case 'smoothie':
                    machineSend('$X\n');
                    writeLog('Sent: $X', 2);
                    break;
                case 'tinyg':
                    machineSend('$X\n'); // resume
                    writeLog('Sent: $X', 2);
                    break;
                }
                writeLog('Resuming Queue Lockout', 1);
                break;
            case 2:
                writeLog('Emptying Queue', 1);
                gcodeQueue.length = 0; // Dump the Queye
                grblBufferSize.length = 0; // Dump bufferSizes
                tinygBufferSize = TINYG_RX_BUFFER_SIZE;  // reset tinygBufferSize
                queueLen = 0;
                queuePointer = 0;
                queuePos = 0;
                startTime = null;
                writeLog('Clearing Lockout', 1);
                switch (firmware) {
                case 'grbl':
                    machineSend('$X\n');
                    writeLog('Sent: $X', 2);
                    blocked = false;
                    paused = false;
                    break;
                case 'smoothie':
                    machineSend('$X\n'); //M999
                    writeLog('Sent: $X', 2);
                    blocked = false;
                    paused = false;
                    break;
                case 'tinyg':
                    machineSend('%'); // flush tinyg quere
                    writeLog('Sent: %', 2);
                    //machineSend('~'); // resume
                    //writeLog('Sent: ~', 2);
                    blocked = false;
                    paused = false;
                    break;
                }
                break;
            }
            io.sockets.emit('runStatus', 'stopped');
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('resetMachine', function () {
        if (isConnected) {
            writeLog(chalk.red('Reset Machine'), 1);
            switch (firmware) {
            case 'grbl':
                machineSend(String.fromCharCode(0x18)); // ctrl-x
                writeLog('Sent: Code(0x18)', 2);
                break;
            case 'smoothie':
                machineSend(String.fromCharCode(0x18)); // ctrl-x
                writeLog('Sent: Code(0x18)', 2);
                break;
            case 'tinyg':
                machineSend(String.fromCharCode(0x18)); // ctrl-x
                writeLog('Sent: Code(0x18)', 2);
                break;
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('closePort', function (data) { // Close machine port and dump queue
        if (isConnected) {
            switch (connectionType) {
            case 'usb':
                writeLog(chalk.yellow('WARN: ') + chalk.blue('Closing Port ' + port.path), 1);
                io.sockets.emit("connectStatus", 'closing:' + port.path);
                //machineSend(String.fromCharCode(0x18)); // ctrl-x
                gcodeQueue.length = 0; // dump the queye
                grblBufferSize.length = 0; // dump bufferSizes
                tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
                clearInterval(queueCounter);
                clearInterval(statusLoop);
                port.close();
                break;
            case 'telnet':
                writeLog(chalk.yellow('WARN: ') + chalk.blue('Closing Telnet @ ' + connectedIp), 1);
                io.sockets.emit("connectStatus", 'closing:' + connectedIp);
                //machineSend(String.fromCharCode(0x18)); // ctrl-x
                gcodeQueue.length = 0; // dump the queye
                grblBufferSize.length = 0; // dump bufferSizes
                tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
                clearInterval(queueCounter);
                clearInterval(statusLoop);
                machineSocket.destroy();
                break;
            case 'esp8266':
                writeLog(chalk.yellow('WARN: ') + chalk.blue('Closing ESP @ ' + connectedIp), 1);
                io.sockets.emit("connectStatus", 'closing:' + connectedIp);
                //machineSend(String.fromCharCode(0x18)); // ctrl-x
                gcodeQueue.length = 0; // dump the queye
                grblBufferSize.length = 0; // dump bufferSizes
                tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
                clearInterval(queueCounter);
                clearInterval(statusLoop);
                machineSocket.close();
                break;
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });
    
    appSocket.on('disconnect', function () { // App disconnected
        let id = connections.indexOf(appSocket);
        writeLog(chalk.yellow('App disconnected! (id=' + id + ')'), 1);
        connections.splice(id, 1);
    });    

}); // End appSocket


// Queue
function addQ(gcode) {
    gcodeQueue.push(gcode);
    queueLen = gcodeQueue.length;
}

//function jumpQ(gcode) {
//    gcodeQueue.unshift(gcode);
//}

function grblBufferSpace() {
    var total = 0;
    var len = grblBufferSize.length;
    for (var i = 0; i < len; i++) {
        total += grblBufferSize[i];
    }
    return GRBL_RX_BUFFER_SIZE - total;
}


function machineSend(gcode) {
    switch (connectionType) {
    case 'usb':
        port.write(gcode);
        break;
    case 'telnet':
        machineSocket.write(gcode);
        break;
    case 'esp8266':
        machineSocket.send(gcode);
        break;
    }
}

function send1Q() {
    var gcode;
    var gcodeLen = 0;
    var gcodeLine = '';
    var spaceLeft = 0;
    if (isConnected) {
        switch (firmware) {
        case 'grbl':
            if (new_grbl_buffer) {
                if (grblBufferSize.length === 0){
                    spaceLeft = GRBL_RX_BUFFER_SIZE;
                    while ((queueLen - queuePointer) > 0 && spaceLeft > 0 && !blocked && !paused) {
                        gcodeLen = gcodeQueue[queuePointer].length;
                        if (gcodeLen < spaceLeft) {
                            // Add gcode to send buffer
                            gcode = gcodeQueue[queuePointer];
                            queuePointer++;
                            grblBufferSize.push(gcodeLen + 1);
                            gcodeLine += gcode + '\n';
                            spaceLeft = GRBL_RX_BUFFER_SIZE - gcodeLine.length;
                        } else {
                            // Not enough space left in send buffer
                            blocked = true;
                        }
                    }
                    if (gcodeLine.length > 0) {
                        // Send the buffer
                        blocked = true;
                        machineSend(gcodeLine);
                        writeLog('Sent: ' + gcodeLine + ' Q: ' + (queueLen - queuePointer), 2);
                    }
                }
            } else {
                while ((queueLen - queuePointer) > 0 && !blocked && !paused) {
                    spaceLeft = grblBufferSpace();
                    gcodeLen = gcodeQueue[queuePointer].length;
                    if (gcodeLen < spaceLeft) {
                        gcode = gcodeQueue[queuePointer];
                        queuePointer++;
                        grblBufferSize.push(gcodeLen + 1);
                        machineSend(gcode + '\n');
                        writeLog('Sent: ' + gcode + ' Q: ' + (queueLen - queuePointer) + ' Bspace: ' + (spaceLeft - gcodeLen - 1), 2);
                    } else {
                        blocked = true;
                    }
                }
            }
            break;
        case 'smoothie':
            if (smoothie_buffer) {
                spaceLeft = SMOOTHIE_RX_BUFFER_SIZE;
                while ((queueLen - queuePointer) > 0 && spaceLeft > 5 && !blocked && !paused) {
                    gcodeLen = gcodeQueue[queuePointer].length;
                    if (gcodeLen < spaceLeft) {
                        // Add gcode to send buffer
                        gcodeLine += gcodeQueue[queuePointer];
                        queuePointer++;
                        spaceLeft -= gcodeLen;
                    } else {
                        // Not enough space left in send buffer
                        blocked = true;
                    }
                }
                if (gcodeLine.length > 0) {
                    // Send the buffer
                    blocked = true;
                    machineSend(gcodeLine + '\n');
                    writeLog('Sent: ' + gcodeLine + ' Q: ' + (queueLen - queuePointer), 2);
                }
            } else {
                if ((gcodeQueue.length  - queuePointer) > 0 && !blocked && !paused) {
                    gcode = gcodeQueue[queuePointer];
                    queuePointer++;
                    blocked = true;
                    machineSend(gcode + '\n');
                    writeLog('Sent: ' + gcode + ' Q: ' + gcodeQueue.length, 2);
                }
            }
            break;
        case 'tinyg':
            while (tinygBufferSize > 0 && gcodeQueue.length > 0 && !blocked && !paused) {
                gcode = gcodeQueue.shift();
                machineSend(gcode + '\n');
                tinygBufferSize--;
                writeLog('Sent: ' + gcode + ' Q: ' + gcodeQueue.length, 2);
            }
            break;
        }
        var finishTime, elapsedTimeMS, elapsedTime, speed;
        if (startTime && (queuePointer - queuePos) >= 500) {
            queuePos = queuePointer;
            finishTime = new Date(Date.now());
            elapsedTimeMS = finishTime.getTime() - startTime.getTime();
            elapsedTime = Math.round(elapsedTimeMS / 1000);
            speed = (queuePointer / elapsedTime).toFixed(0);
            writeLog('Done: ' + queuePointer + ' of ' + queueLen + ' (ave. ' + speed + ' lines/s)', 1);
        }
        if (queuePointer >= gcodeQueue.length) {
            clearInterval(queueCounter);
            io.sockets.emit('qCount', 0);
            if (startTime) {
                finishTime = new Date(Date.now());
                elapsedTimeMS = finishTime.getTime() - startTime.getTime();
                elapsedTime = Math.round(elapsedTimeMS / 1000);
                speed = (queuePointer / elapsedTime).toFixed(0);
                writeLog("Job started at " + startTime.toString(), 1);
                writeLog("Job finished at " + finishTime.toString(), 1);
                writeLog("Elapsed time: " + elapsedTime + " seconds.", 1);
                writeLog('Ave. Speed: ' + speed + ' lines/s', 1);
            }
            gcodeQueue.length = 0; // Dump the Queye
            grblBufferSize.length = 0; // Dump bufferSizes
            tinygBufferSize = TINYG_RX_BUFFER_SIZE;  // reset tinygBufferSize
            queueLen = 0;
            queuePointer = 0;
            queuePos = 0;
            startTime = null;
            runningJob = null;
            io.sockets.emit('runStatus', 'finished');
        }
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Error while send1Q(): Machine connection not open!'), 2);
    }
}


function writeLog(line, verb) {
    if (verb<=config.verboseLevel) {
        console.log(line);
    }
    if (config.logLevel>0 && verb<=config.logLevel) {
        if (!logFile) {
            logFile = fs.createWriteStream('logfile.txt');
        }
        var time = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
        line = line.split(String.fromCharCode(0x1B) + '[31m').join('');
        line = line.split(String.fromCharCode(0x1B) + '[32m').join('');
        line = line.split(String.fromCharCode(0x1B) + '[33m').join('');
        line = line.split(String.fromCharCode(0x1B) + '[34m').join('');
        line = line.split(String.fromCharCode(0x1B) + '[35m').join('');
        line = line.split(String.fromCharCode(0x1B) + '[36m').join('');
        line = line.split(String.fromCharCode(0x1B) + '[37m').join('');
        line = line.split(String.fromCharCode(0x1B) + '[38m').join('');
        line = line.split(String.fromCharCode(0x1B) + '[39m').join('');
        line = line.split(String.fromCharCode(0x1B) + '[94m').join('');
        logFile.write(time + ' ' + line + '\r\n');
    }
}

// Electron app
const electron = require('electron');
// Module to control application life.
const electronApp = electron.app;
// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
var mainWindow = null;

const shouldQuit = electronApp.makeSingleInstance((commandLine, workingDirectory) => {
  // Someone tried to run a second instance, we should focus our window.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

if (shouldQuit) {
  electronApp.quit();
}

// Create myWindow, load the rest of the app, etc...
if (electronApp) {
    // Module to create native browser window.
    const BrowserWindow = electron.BrowserWindow;

    function createWindow() {
        // Create the browser window.
        mainWindow = new BrowserWindow({width: 1200, height: 900, fullscreen: false, center: true, resizable: true, title: "LaserWeb", frame: true, autoHideMenuBar: true, icon: '/public/favicon.png' });

        // and load the index.html of the app.
        mainWindow.loadURL('http://127.0.0.1:8000');

        // Emitted when the window is closed.
        mainWindow.on('closed', function () {
            // Dereference the window object, usually you would store windows
            // in an array if your app supports multi windows, this is the time
            // when you should delete the corresponding element.
            mainWindow = null;
        });
        mainWindow.once('ready-to-show', () => {
          mainWindow.show()
        })
        mainWindow.maximize()
        //mainWindow.webContents.openDevTools() // Enable when testing 
    };

    electronApp.commandLine.appendSwitch("--ignore-gpu-blacklist");
    electronApp.commandLine.appendSwitch("--disable-http-cache");
    // This method will be called when Electron has finished
    // initialization and is ready to create browser windows.
    // Some APIs can only be used after this event occurs.


    electronApp.on('ready', createWindow);

    // Quit when all windows are closed.
    electronApp.on('window-all-closed', function () {
        // On OS X it is common for applications and their menu bar
        // to stay active until the user quits explicitly with Cmd + Q
        if (process.platform !== 'darwin') {
            electronApp.quit();
        }
    });

    electronApp.on('activate', function () {
        // On OS X it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (mainWindow === null) {
            createWindow();
        }
    });
}
