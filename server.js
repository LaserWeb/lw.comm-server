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

const config = require('./config');
const serialport = require('serialport');
var SerialPort = serialport;
const Readline = SerialPort.parsers.Readline;
const websockets = require('socket.io');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const os = require('os');
const ip = require("ip");
const fs = require('fs');
const path = require('path');
const nstatic = require('node-static');
const url = require('url');
const util = require('util');
const chalk = require('chalk');
const request = require('request'); // proxy for remote webcams
const grblStrings = require('./grblStrings.js');
const firmwareFeatures = require('./firmwareFeatures.js');
const { exec } = require('child_process'); //Support for running OS commands before and after jobs

exports.LWCommServer=function(config){

//var EventEmitter = require('events').EventEmitter;
//var qs = require('querystring');

var logFile;
var connectionType, connections = [];
var gcodeQueue = [];
var port, parser, isConnected, connectedTo, portsList;
var telnetSocket, espSocket, connectedIp;
var telnetBuffer, espBuffer;

var statusLoop, queueCounter, listPortsLoop = false;
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
var jobRequestIP;

var optimizeGcode = false;

var supportedInterfaces = ['USB', 'ESP8266', 'Telnet'];

var GRBL_RX_BUFFER_SIZE = config.grblBufferSize;            // max. chars (default: 128)
var grblBufferSize = [];
var new_grbl_buffer = false;

var SMOOTHIE_RX_BUFFER_SIZE = config.smoothieBufferSize;    // max. length of one command line (default: 64)
var smoothie_buffer = false;
var lastMode;

var TINYG_RX_BUFFER_SIZE = config.tinygBufferSize;          // max. lines of gcode to send before wait for ok (default: 24)
var tinygBufferSize = TINYG_RX_BUFFER_SIZE;                 // init space left
var jsObject;

var REPRAP_RX_BUFFER_SIZE = config.reprapBufferSize;        // max. lines of gcode to send before wait for ok (default: 2)
var reprapBufferSize = REPRAP_RX_BUFFER_SIZE;               // init space left
var reprapWaitForPos = false;

var xPos = 0.00, yPos = 0.00, zPos = 0.00, aPos = 0.00;
var xOffset = 0.00, yOffset = 0.00, zOffset = 0.00, aOffset = 0.00;
var has4thAxis = false;

var add = ip.address();

writeLog(chalk.green(' '), 0);
writeLog(chalk.green('***************************************************************'), 0);
writeLog(chalk.white('        ---- LaserWeb Comm Server ' + config.serverVersion + ' ----        '), 0);
writeLog(chalk.green('***************************************************************'), 0);
writeLog(chalk.white('  Use ') + chalk.yellow(' http://' + add + ':' + config.webPort) + chalk.white(' to connect to this server.'), 0);
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
writeLog(chalk.green('  ') + chalk.yellow('https://forum.makerforums.info/c/laserweb-cncweb/78'), 0);
writeLog(chalk.green('***************************************************************'), 0);
writeLog(chalk.green(' '), 0);


// Init webserver
var webServer = new nstatic.Server(config.uipath || path.join(__dirname, '/app'));
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

if (config.IP == "0.0.0.0") {
    writeLog(chalk.yellow('Server binding to all local IP addresses on port: ' + config.webPort), 1);
} else {
    writeLog(chalk.yellow('Server binding to IP: ' + config.IP + ' on port: ' + config.webPort), 1);
}
app.listen(config.webPort, config.IP);
var io = websockets(app, {
    maxHttpBufferSize: config.socketMaxDataSize,
    cors: {
        origin: config.socketCorsOrigin,
        methods: ["GET", "POST"]
    },
    pingTimeout:  config.socketPingTimeout,
    pingInterval: config.socketPingInterval
});


// MPG communication
const HID = require("node-hid");
var vendorId = 4302;    // for MPG: XHC HB04-L (0x10CE)
var productId = 60272;  // for MPG: XHC HB04-L (0xEB70)
var mpgType = config.mpgType;
var mpgRead, mpgWrite;
var macro = [];
if (mpgType != 0){
    switch(mpgType){
    case 'HB03':
    case 'HB04':
        var devices = HID.devices();
        devices.forEach(function(device) {
            if (device.vendorId == vendorId && device.productId == productId){
                if (!mpgRead) {
                    mpgRead = new HID.HID(device.path);
                    console.log("HID read device: " + device.path);
                } else {
                    mpgWrite = new HID.HID(device.path);
                    console.log("HID write device: " + device.path);
                    console.log(mpgWrite.getFeatureReport(6, 8));
                }
            }
        });
        if (mpgRead) {
            mpgRead.on("data", function (data) {
                writeLog(chalk.yellow('MPG read data: ' + JSON.stringify(data)), 1);
                if (data) {
                    parseMPGPacket(data);
                }
            });
            mpgRead.on("error", function (data) {
                writeLog(chalk.yellow('MPG read error: ' + JSON.stringify(data)), 1);
            });
        }
        if (mpgWrite) {
            mpgWrite.on("data", function (data) {
                writeLog(chalk.yellow('MPG write data: ' + JSON.stringify(data)), 1);
            });
            mpgWrite.on("error", function (data) {
                writeLog(chalk.yellow('MPG write error: ' + JSON.stringify(data)), 1);
            });
        }
        break;
    }
}


// WebSocket connection from frontend
io.sockets.on('connection', function (appSocket) {

    // save new connection
    connections.push(appSocket);
    writeLog(chalk.yellow('App connected! (id=' + connections.indexOf(appSocket) + ', ip=' + appSocket.handshake.address + ')'), 1);

    // send supported interfaces
    writeLog(chalk.yellow('Connect (' + connections.indexOf(appSocket) + ') ') + chalk.blue('Sending Interfaces list: ' + supportedInterfaces), 1);
    appSocket.emit('interfaces', supportedInterfaces);

    // check available ports
    serialport.list().then(ports => {
        portsList = ports;
        let portPaths= new Array();
        for (var i = 0; i < ports.length; i++) {
              portPaths.push(ports[i].path);
        }
        writeLog(chalk.yellow('Connect(' + connections.indexOf(appSocket) + ') ') + chalk.blue('Sending Ports list: ' + portPaths), 1);
        appSocket.emit('ports', portsList);
    });
    // reckeck ports every 2s
    if (!listPortsLoop) {
        listPortsLoop = setInterval(function () {
            serialport.list().then(ports => {
                if (JSON.stringify(ports) != JSON.stringify(portsList)) {
                    portsList = ports;
                    io.sockets.emit('ports', portsList);
                    let portPaths= new Array();
                    for (var i = 0; i < ports.length; i++) {
                          portPaths.push(ports[i].path);
                    }
                    writeLog(chalk.yellow('Ports changed: ' + portPaths), 1);
                }
            });
        }, 2000);
    }

    if (isConnected) {
        appSocket.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
        if (port) {
            appSocket.emit('connectStatus', 'opened:' + port.path);
            appSocket.emit('activePort', port.path);
            appSocket.emit('activeBaudRate', port.settings.baudRate);
        } else {
            appSocket.emit('connectStatus', 'opened:' + connectedTo);
            appSocket.emit('activeIP', connectedTo);
        }
        if (runningJob) {
            let currentTime = new Date(Date.now());
            let elapsedTimeMS = currentTime.getTime() - startTime.getTime();
            let elapsedTime = Math.round(elapsedTimeMS / 1000);
            let speed = (queuePointer / elapsedTime);
            if (speed >= 100) speed = speed.toFixed(0);
            else speed = speed.toPrecision(3);
            let pct = ((queuePointer / queueLen) * 100).toFixed(1);
            appSocket.emit('runningJobStatus', 'Running job started @ ' + startTime.toLocaleTimeString() + ' on ' + startTime.toLocaleDateString() + ' from ' + jobRequestIP + '<br/>Queue: ' + queuePointer + ' done of ' + queueLen + ' (' + pct + '%, ave. ' + speed + ' lines/s)');
        }
    } else {
        appSocket.emit('connectStatus', 'Connect');
    }

    appSocket.on('firstLoad', function () {
        writeLog(chalk.yellow('INFO: ') + chalk.blue('FirstLoad called'), 1);
        appSocket.emit('serverConfig', config);
        appSocket.emit('interfaces', supportedInterfaces);
        serialport.list().then(ports => {
            appSocket.emit('ports', ports);
        });
        if (isConnected) {
            appSocket.emit('activeInterface', connectionType);
            switch (connectionType) {
            case 'usb':
                appSocket.emit('activePort', port.path);
                appSocket.emit('activeBaudRate', port.settings.baudRate);
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
        serialport.list().then(ports => {
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
                appSocket.emit('activeBaudRate', port.settings.baudRate);
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

    appSocket.on('getFeatureList', function (data) { // Deliver supported Firmware Features to Web-Client
        appSocket.emit('featureList', firmwareFeatures.get(firmware));
    });

    appSocket.on('getRunningJob', function (data) { // Deliver running Job to Web-Client
        appSocket.emit('runningJob', runningJob);
    });

    appSocket.on('connectTo', function (data) { // If a user picks a port to connect to, open a Node SerialPort Instance to it
        data = data.split(',');
        let reset = false;
        if (config.resetOnConnect == 1) reset = true;
        writeLog(chalk.yellow('INFO: ') + chalk.blue('Connecting to ' + data), 1);
        if (!isConnected) {
            connectionType = data[0].toLowerCase();
            if (data.length >= 4) {  // if client supplies true/false, use that
                switch(data[3]) {
                case 'true':
                    reset = true;
                    break;
                case 'false':
                    reset = false;
                    break;
                }
            }
            firmware = false;
            switch (connectionType) {
            case 'usb':
                port = new SerialPort(data[1], {
                    baudRate: parseInt(data[2].replace('baud',''))
                });
                const parser = port.pipe(new Readline({ delimiter: '\n' }))
                // parser.on('data', console.log)  // uncomment to dump raw data from the connected port
                io.sockets.emit('connectStatus', 'opening:' + port.path);

                // Serial port events -----------------------------------------------
                port.on('open', function () {
                    io.sockets.emit('activePort', {port: port.path, baudrate: port.settings.baudRate});
                    io.sockets.emit('connectStatus', 'opened:' + port.path);
                    if (reset) {
                        port.write(String.fromCharCode(0x18)); // ctrl-x (reset firmware)
                        writeLog('Sent: ctrl-x', 1);
                    } else {
                        machineSend('\n'); // this causes smoothie to send the welcome string
                        writeLog('Sent: \\n', 1);
                    }
                    setTimeout(function () { //wait for controller to be ready
                        if (!firmware) { // Grbl should be already detected
                            machineSend('version\n'); // Check if it's Smoothieware?
                            writeLog('Sent: version', 2);
                            setTimeout(function () {  // Wait for Smoothie to answer
                                if (!firmware) {     // If still not set
                                    machineSend('{fb:n}\n'); // Check if it's TinyG
                                    writeLog('Sent: {fb:n}', 2);
                                    setTimeout(function () {  // Wait for TinyG to answer
                                        if (!firmware) {     // If still not set
                                            machineSend('M115\n'); // Check if it's Repetier, Marlin, MK, RepRap
                                            reprapBufferSize--;
                                            writeLog('Sent: M115', 2);
                                        }
                                    }, config.tinygWaitTime * 1000);
                                }
                            }, config.smoothieWaitTime * 1000);
                        }
                    }, config.grblWaitTime * 1000);
                    if (config.firmwareWaitTime > 0) {
                        setTimeout(function () {
                            // Close port if we don't detect supported firmware after 2s.
                            if (!firmware) {
                                writeLog('No supported firmware detected. Closing port ' + port.path, 1);
                                io.sockets.emit('data', 'No supported firmware detected. Closing port ' + port.path);
                                io.sockets.emit('connectStatus', 'closing:' + port.path);
                                clearInterval(queueCounter);
                                clearInterval(statusLoop);
                                gcodeQueue.length = 0; // dump the queye
                                grblBufferSize.length = 0; // dump bufferSizes
                                tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
                                reprapBufferSize = REPRAP_RX_BUFFER_SIZE; // reset reprapBufferSize
                                reprapWaitForPos = false;
                                port.close();
                            }
                        }, config.firmwareWaitTime * 1000);
                    }
                    //machineSend("M115\n");    // Lets check if its Marlin?

                    writeLog(chalk.yellow('INFO: ') + 'Connected to ' + port.path + ' at ' + port.settings.baudRate, 1);
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

                parser.on('data', function (data) {
                    //data = data.toString().trimStart();
                    writeLog('Recv: ' + data, 3);
                    if (data.indexOf('ok') === 0) { // Got an OK so we are clear to send
                        if (firmware === 'grbl') {
                            grblBufferSize.shift();
                        }
                        if (firmware === 'repetier' || firmware === 'marlinkimbra' || firmware === 'marlin' || firmware === 'reprapfirmware') {
                            reprapBufferSize++;
                        }
                        blocked = false;
                        send1Q();
                    } else if (data.indexOf('<') === 0) { // Got statusReport (Grbl & Smoothieware)
                        var state = data.substring(1, data.search(/(,|\|)/));
                        //appSocket.emit('runStatus', state);
                        io.sockets.emit('data', data);
                        if (firmware == 'grbl') {
                            // Extract wPos (for Grbl > 1.1 only!)
                            var startWPos = data.search(/wpos:/i) + 5;
                            var wPos;
                            if (startWPos > 5) {
                                var wPosLen = data.substr(startWPos).search(/>|\|/);
                                wPos = data.substr(startWPos, wPosLen).split(/,/);
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
                                if (wPos.length > 3) {
                                    if (aPos !== parseFloat(wPos[3]).toFixed(config.posDecimals)) {
                                        aPos = parseFloat(wPos[3]).toFixed(config.posDecimals);
                                        send = true;
                                        has4thAxis = true;
                                    }
                                }
                                if (send) {
                                    if (has4thAxis) {
                                        io.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos, a: aPos});
                                        setMpgWPos({x: xPos, y: yPos, z: zPos, a: aPos});
                                    } else {
                                        io.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos});
                                        setMpgWPos({x: xPos, y: yPos, z: zPos});
                                    }
                                }
                            }
                            // Extract work offset (for Grbl > 1.1 only!)
                            var startWCO = data.search(/wco:/i) + 4;
                            var wco;
                            if (startWCO > 4) {
                                wco = data.replace('>', '').substr(startWCO).split(/,|\|/, 4);
                            }
                            if (Array.isArray(wco)) {
                                xOffset = parseFloat(wco[0]).toFixed(config.posDecimals);
                                yOffset = parseFloat(wco[1]).toFixed(config.posDecimals);
                                zOffset = parseFloat(wco[2]).toFixed(config.posDecimals);
                                if (has4thAxis) {
                                    aOffset = parseFloat(wco[3]).toFixed(config.posDecimals);
                                }
                                if (send) {
                                    if (has4thAxis) {
                                        io.sockets.emit('wOffset', {x: xOffset, y: yOffset, z: zOffset, a: aOffset});
                                        setMpgWOffset({x: xOffset, y: yOffset, z: zOffset, a: aOffset});
                                    } else {
                                        io.sockets.emit('wOffset', {x: xOffset, y: yOffset, z: zOffset});
                                        setMpgWOffset({x: xOffset, y: yOffset, z: zOffset});
                                    }
                                }
                            }
                        }
                        if (firmware == 'smoothie') {
                            // Extract wPos (for Smoothieware only!)
                            var startWPos = data.search(/wpos:/i) + 5;
                            var wPos;
                            if (startWPos > 5) {
                                wPos = data.replace('>', '').substr(startWPos).split(/,/, 4);
                            }
                            if (Array.isArray(wPos)) {
                                var send = true;
                                if (xPos !== wPos[0]) {
                                    xPos = wPos[0];
                                    send = true;
                                }
                                if (yPos !== wPos[1]) {
                                    yPos = wPos[1];
                                    send = true;
                                }
                                if (zPos !== wPos[2]) {
                                    zPos = wPos[2];
                                    send = true;
                                }
                                if (wPos.length > 3) {
                                    if (aPos !== wPos[3]) {
                                        aPos = wPos[3];
                                        send = true;
                                        has4thAxis = true;
                                    }
                                }
                                if (send) {
                                    if (has4thAxis) {
                                        io.sockets.emit('wPos', {x: parseFloat(xPos).toFixed(config.posDecimals), y: parseFloat(yPos).toFixed(config.posDecimals), z: parseFloat(zPos).toFixed(config.posDecimals), a: parseFloat(aPos).toFixed(config.posDecimals)});
                                        setMpgWPos({x: xPos, y: yPos, z: zPos, a: aPos});
                                    } else {
                                        io.sockets.emit('wPos', {x: parseFloat(xPos).toFixed(config.posDecimals), y: parseFloat(yPos).toFixed(config.posDecimals), z: parseFloat(zPos).toFixed(config.posDecimals)});
                                        setMpgWPos({x: xPos, y: yPos, z: zPos});
                                    }
                                }
                            }
                            // Extract mPos (for Smoothieware only!)
                            var startMPos = data.search(/mpos:/i) + 5;
                            var mPos;
                            if (startMPos > 5) {
                                mPos = data.replace('>', '').substr(startMPos).split(/,|\|/, 4);
                            }
                            if (Array.isArray(mPos)) {
                                var send = false;
                                if (xOffset != mPos[0] - xPos) {
                                    xOffset = mPos[0] - xPos;
                                    send = true;
                                }
                                if (yOffset != mPos[1] - yPos) {
                                    yOffset = mPos[1] - yPos;
                                    send = true;
                                }
                                if (zOffset != mPos[2] - zPos) {
                                    zOffset = mPos[2] - zPos;
                                    send = true;
                                }
                                if (has4thAxis) {
                                    if (aOffset != mPos[3] - aPos) {
                                        aOffset = mPos[3] - aPos;
                                        send = true;
                                    }
                                }
                                if (send) {
                                    if (has4thAxis) {
                                        io.sockets.emit('wOffset', {x: parseFloat(xOffset).toFixed(config.posDecimals), y: parseFloat(yOffset).toFixed(config.posDecimals), z: parseFloat(zOffset).toFixed(config.posDecimals), a: parseFloat(aOffset).toFixed(config.posDecimals)});
                                        setMpgWOffset({x: xOffset, y: yOffset, z: zOffset, a: aOffset});
                                    } else {
                                        io.sockets.emit('wOffset', {x: parseFloat(xOffset).toFixed(config.posDecimals), y: parseFloat(yOffset).toFixed(config.posDecimals), z: parseFloat(zOffset).toFixed(config.posDecimals)});
                                        setMpgWOffset({x: xOffset, y: yOffset, z: zOffset});
                                    }
                                }
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
                    } else if (data.indexOf('X') === 0) {   // Extract wPos for RepRap (Repetier, Marlin, MK, RepRapFirmware)
                        var pos;
                        var startPos = data.search(/x:/i) + 2;
                        if (startPos >= 2) {
                            pos = data.substr(startPos, 4);
                            if (xPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                                xPos = parseFloat(pos).toFixed(config.posDecimals);
                            }
                        }
                        var startPos = data.search(/y:/i) + 2;
                        if (startPos >= 2) {
                            pos = data.substr(startPos, 4);
                            if (yPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                                yPos = parseFloat(pos).toFixed(config.posDecimals);
                            }
                        }
                        var startPos = data.search(/z:/i) + 2;
                        if (startPos >= 2) {
                            pos = data.substr(startPos, 4);
                            if (zPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                                zPos = parseFloat(pos).toFixed(config.posDecimals);
                            }
                        }
                        var startPos = data.search(/e:/i) + 2;
                        if (startPos >= 2) {
                            pos = data.substr(startPos, 4);
                            if (aPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                                aPos = parseFloat(pos).toFixed(config.posDecimals);
                            }
                        }
                        io.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos, a: aPos});
                        setMpgWPos({x: xPos, y: yPos, z: zPos, a: aPos});
                        //writeLog('wPos: X:' + xPos + ' Y:' + yPos + ' Z:' + zPos + ' E:' + aPos, 3);
                        if (firmware === 'reprapfirmware') {
                            //reprapBufferSize++;
                        }
                        reprapWaitForPos = false;

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
                    } else if (data.indexOf('start') === 0) { // Check if it's RepRap
                        machineSend('M115\n'); // Check if it's Repetier or MarlinKimbra
                        reprapBufferSize--;
                        writeLog('Sent: M115', 2);
                    } else if (data.indexOf('FIRMWARE_NAME:Repetier') >= 0) { // Check if it's Repetier
                        firmware = 'repetier';
                        var startPos = data.search(/repetier_/i) + 9;
                        fVersion = data.substr(startPos, 4); // get version
                        fDate = '';
                        writeLog('Repetier detected (' + fVersion + ')', 1);
                        io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                        // Start intervall for status queries
                        statusLoop = setInterval(function () {
                            if (isConnected) {
                                if (!reprapWaitForPos && reprapBufferSize > 0) {
                                    reprapWaitForPos = true;
                                    machineSend('M114\n'); // query position
                                    reprapBufferSize--;
                                    writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                                }
                            }
                        }, 250);
                    } else if (data.indexOf('FIRMWARE_NAME:Marlin') >= 0) { // Check if it's MarlinKimbra
                        firmware = 'marlin';
                        var startPos = data.search(/marlin_/i) + 7;
                        fVersion = data.substr(startPos, 5); // get version
                        fDate = '';
                        writeLog('Marlin detected (' + fVersion + ')', 1);
                        io.sockets.emit('firmware', { firmware: firmware, version: fVersion, date: fDate });
                        // Start intervall for status queries
                        statusLoop = setInterval(function () {
                            if (isConnected) {
                                if (!reprapWaitForPos && reprapBufferSize >= 0) {
                                    reprapWaitForPos = true;
                                    machineSend('M114\n'); // query position
                                    reprapBufferSize--;
                                    writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                                }
                            }
                        }, 250);
                    } else if (data.indexOf('FIRMWARE_NAME:MK') >= 0) { // Check if it's MarlinKimbra
                        firmware = 'marlinkimbra';
                        var startPos = data.search(/mk_/i) + 3;
                        fVersion = data.substr(startPos, 5); // get version
                        fDate = '';
                        writeLog('MarlinKimbra detected (' + fVersion + ')', 1);
                        io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                        // Start intervall for status queries
                        statusLoop = setInterval(function () {
                            if (isConnected) {
                                if (!reprapWaitForPos && reprapBufferSize >= 0) {
                                    reprapWaitForPos = true;
                                    machineSend('M114\n'); // query position
                                    reprapBufferSize--;
                                    writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                                }
                            }
                        }, 250);
                    } else if (data.indexOf('FIRMWARE_NAME: RepRapFirmware') >= 0) { // Check if it's RepRapFirmware
                        firmware = 'reprapfirmware';
                        var startPos = data.search(/firmware_version:/i) + 18;
                        fVersion = data.substr(startPos, 7); // get version
                        startPos = data.search(/firmware_date:/i) + 16;
                        fDate = new Date(data.substr(startPos, 12));
                        REPRAP_RX_BUFFER_SIZE = 5;
                        reprapBufferSize = REPRAP_RX_BUFFER_SIZE;
                        writeLog('RepRapFirmware detected (' + fVersion + ')', 1);
                        io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                        // Start intervall for status queries
                        statusLoop = setInterval(function () {
                            if (isConnected) {
                                if (!reprapWaitForPos && reprapBufferSize > 0) {
                                    reprapWaitForPos = true;
                                    machineSend('M114\n'); // query position
                                    reprapBufferSize--;
                                    writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                                }
                            }
                        }, 250);
                    } else if (data.indexOf('{') === 0) { // JSON response (probably TinyG)
                        try {
                            var jsObject = JSON.parse(data);
                        } catch(err) {
                            console.error('Recieved invalid JSON response on connection:')
                            console.error(data)
                            var jsObject = "{}"
                        }
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
                            if (jsObject.sr.posa != null) {
                                aPos = parseFloat(jsObject.sr.posa).toFixed(config.posDecimals);
                                send = true;
                            }
                            if (send) {
                                io.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos, a: aPos});
                                setMpgWPos({x: xPos, y: yPos, z: zPos, a: aPos});
                               //writeLog('wPos: ' + xPos + ', ' + yPos + ', ' + zPos + ', ' + aPos, 3);
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
                            grblBufferSize.shift();
                            var alarmCode = parseInt(data.split(':')[1]);
                            writeLog('ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode));
                            io.sockets.emit('data', 'ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode));
                            break;
                        case 'smoothie':
                        case 'tinyg':
                        case 'repetier':
                        case 'marlinkimbra':
                        case 'marlin':
                        case 'reprapfirmware':
                            io.sockets.emit('data', data);
                            break;
                        }
                    } else if (data.indexOf('wait') === 0) { // Got wait from Repetier -> ignore
                        // do nothing
                    } else if (data.indexOf('Resend') === 0) { // Got resend from Repetier -> TODO: resend corresponding line!!!
                        switch (firmware) {
                        case 'repetier':
                        case 'marlinkimbra':
                        case 'marlin':
                        case 'reprapfirmware':
                            break;
                        }
                    } else if (data.indexOf('error') === 0) { // Error received -> stay blocked stops queue
                        switch (firmware) {
                        case 'grbl':
                            grblBufferSize.shift();
                            var errorCode = parseInt(data.split(':')[1]);
                            writeLog('error: ' + errorCode + ' - ' + grblStrings.errors(errorCode));
                            io.sockets.emit('data', 'error: ' + errorCode + ' - ' + grblStrings.errors(errorCode));
                            break;
                        case 'smoothie':
                        case 'tinyg':
                        case 'repetier':
                        case 'marlinkimbra':
                        case 'marlin':
                        case 'reprapfirmware':
                            io.sockets.emit('data', data);
                            break;
                        }
                    } else if (data === ' ') {
                        // nothing
                    } else {
                        io.sockets.emit('data', data);
                    }
                });
                break;

            case 'telnet':  // Only supported by smoothieware!
                connectedIp = data[1];
                telnetSocket = net.connect(23, connectedIp);
                io.sockets.emit('connectStatus', 'opening:' + connectedIp);

                // Telnet connection events -----------------------------------------------
                telnetSocket.on('connect', function (prompt) {
                    io.sockets.emit('activeIP', connectedIp);
                    io.sockets.emit('connectStatus', 'opened:' + connectedIp);
                    if (reset) {
                        machineSend(String.fromCharCode(0x18)); // ctrl-x (reset firmware)
                        writeLog('Sent: ctrl-x', 1);
                    } else {
                        machineSend('\n'); // this causes smoothie to send the welcome string
                        writeLog('Sent: \\n', 1);
                    }
                    setTimeout(function () { //wait for controller to be ready
                        if (!firmware) { // Grbl should be already detected
                            machineSend('version\n'); // Check if it's Smoothieware?
                            writeLog('Sent: version', 2);
                            setTimeout(function () {  // Wait for Smoothie to answer
                                if (!firmware) {     // If still not set
                                    machineSend('{fb:n}\n'); // Check if it's TinyG
                                    writeLog('Sent: {fb:n}', 2);
                                    setTimeout(function () {  // Wait for TinyG to answer
                                        if (!firmware) {     // If still not set
                                            machineSend('M115\n'); // Check if it's RepRap
                                            reprapBufferSize--;
                                            writeLog('Sent: M115', 2);
                                        }
                                    }, config.tinygWaitTime * 1000);
                                }
                            }, config.smoothieWaitTime * 1000);
                        }
                    }, config.grblWaitTime * 1000);
                    if (config.firmwareWaitTime > 0) {
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
                                telnetSocket.destroy();
                            }
                        }, config.firmwareWaitTime * 1000);
                    }

                    writeLog(chalk.yellow('INFO: ') + chalk.blue('Telnet connected to ' + connectedIp), 1);
                    isConnected = true;
                    connectedTo = connectedIp;

                    // Start interval for qCount messages to appSocket clients
//                    queueCounter = setInterval(function () {
//                        io.sockets.emit('qCount', gcodeQueue.length);
//                    }, 500);
                });

                telnetSocket.on('timeout', function () {
                    writeLog(chalk.yellow('WARN: ') + chalk.blue('Telnet timeout!'), 1);
                    telnetSocket.end();
                });

                telnetSocket.on('close', function (e) {
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

                telnetSocket.on('error', function (e) {
                    io.sockets.emit("error", e.message);
                    writeLog(chalk.red('ERROR: ') + 'Telnet error: ' + e.message, 1);
                });

                telnetSocket.on('data', function (response) {
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
                            if (firmware === 'grbl') {
                                grblBufferSize.shift();
                            }
                            if (firmware === 'repetier' || firmware === 'marlinkimbra' || firmware === 'marlin' || firmware === 'reprapfirmware') {
                                reprapBufferSize++;
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
                                wPos = data.replace('>', '').substr(startWPos).split(/,|\|/, 4);
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
                                if (aPos !== parseFloat(wPos[3]).toFixed(config.posDecimals)) {
                                    aPos = parseFloat(wPos[3]).toFixed(config.posDecimals);
                                    send = true;
                                }
                                if (send) {
                                    io.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos, a: aPos});
                                    setMpgWPos({x: xPos, y: yPos, z: zPos, a: aPos});
                                }
                            }
                            // Extract mPos (for smoothieware only!)
                            var startMPos = data.search(/mpos:/i) + 5;
                            var mPos;
                            if (startMPos > 5) {
                                mPos = data.replace('>', '').substr(startMPos).split(/,|\|/, 4);
                            }
                            if (Array.isArray(mPos)) {
                                var send = false;
                                if (xOffset !== parseFloat(mPos[0] - xPos).toFixed(config.posDecimals)) {
                                    xOffset = parseFloat(mPos[0] - xPos).toFixed(config.posDecimals);
                                    send = true;
                                }
                                if (yOffset !== parseFloat(mPos[1] - yPos).toFixed(config.posDecimals)) {
                                    yOffset = parseFloat(mPos[1] - yPos).toFixed(config.posDecimals);
                                    send = true;
                                }
                                if (zOffset !== parseFloat(mPos[2] - zPos).toFixed(config.posDecimals)) {
                                    zOffset = parseFloat(mPos[2] - zPos).toFixed(config.posDecimals);
                                    send = true;
                                }
                                if (aOffset !== parseFloat(mPos[3] - aPos).toFixed(config.posDecimals)) {
                                    aOffset = parseFloat(mPos[3] - aPos).toFixed(config.posDecimals);
                                    send = true;
                                }
                                if (send) {
                                    io.sockets.emit('wOffset', {x: xOffset, y: yOffset, z: zOffset, a: aOffset});
                                }
                            }
                            // Extract work offset (for Grbl > 1.1 only!)
                            var startWCO = data.search(/wco:/i) + 4;
                            var wco;
                            if (startWCO > 4) {
                                wco = data.replace('>', '').substr(startWCO).split(/,|\|/, 4);
                            }
                            if (Array.isArray(wco)) {
                                xOffset = parseFloat(wco[0]).toFixed(config.posDecimals);
                                yOffset = parseFloat(wco[1]).toFixed(config.posDecimals);
                                zOffset = parseFloat(wco[2]).toFixed(config.posDecimals);
                                aOffset = parseFloat(wco[3]).toFixed(config.posDecimals);
                                if (send) {
                                    io.sockets.emit('wOffset', {x: xOffset, y: yOffset, z: zOffset, a: aOffset});
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
                        } else if (data.indexOf('X') === 0) {   // Extract wPos for Repetier, Marlin, MK, RepRapFirmware
                            var pos;
                            var startPos = data.search(/x:/i) + 2;
                            if (startPos >= 2) {
                                pos = data.substr(startPos, 4);
                                if (xPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                                    xPos = parseFloat(pos).toFixed(config.posDecimals);
                                }
                            }
                            var startPos = data.search(/y:/i) + 2;
                            if (startPos >= 2) {
                                pos = data.substr(startPos, 4);
                                if (yPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                                    yPos = parseFloat(pos).toFixed(config.posDecimals);
                                }
                            }
                            var startPos = data.search(/z:/i) + 2;
                            if (startPos >= 2) {
                                pos = data.substr(startPos, 4);
                                if (zPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                                    zPos = parseFloat(pos).toFixed(config.posDecimals);
                                }
                            }
                            var startPos = data.search(/e:/i) + 2;
                            if (startPos >= 2) {
                                pos = data.substr(startPos, 4);
                                if (aPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                                    aPos = parseFloat(pos).toFixed(config.posDecimals);
                                }
                            }
                            io.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos, a: aPos});
                            setMpgWPos({x: xPos, y: yPos, z: zPos, a: aPos});
                            //writeLog('wPos: X:' + xPos + ' Y:' + yPos + ' Z:' + zPos + ' E:' + aPos, 3);
                            reprapWaitForPos = false;
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
                                var wapos = parseFloat(wpos[7]).toFixed(2);
                                var wpos = wxpos + ',' + wypos + ',' + wzpos + ',' + wapos;
                                writeLog('Telnet: ' + 'WPos:' + wpos, 1);
                                io.sockets.emit('wPos', {x: wxpos, y: wypos, z: wzpos, a: wapos});
                                setMpgWPos({x: wxpos, y: wypos, z: wzpos, a: wapos});
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
                                var mapos = parseFloat(mpos[7]).toFixed(2);
                                var mpos = mxpos + ',' + mypos + ',' + mzpos + ',' + mapos;
                                writeLog('Telnet: ' + 'MPos:' + mpos, 1);
                                io.sockets.emit('mPos', {x: mxpos, y: mypos, z: mzpos, a: mapos});
                                setMpgMPos({x: mxpos, y: mypos, z: mzpos, a: mapos});
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
                        } else if (data.indexOf('start') === 0) { // Check if it's RepRap
                            machineSend('M115\n'); // Check if it's Repetier or Marlin(Kimbra)
                            reprapBufferSize--;
                            writeLog('Sent: M115', 2);
                        } else if (data.indexOf('FIRMWARE_NAME:Repetier') >= 0) { // Check if it's Repetier
                            firmware = 'repetier';
                            var startPos = data.search(/repetier_/i) + 9;
                            fVersion = data.substr(startPos, 4); // get version
                            fDate = '';
                            writeLog('Repetier detected (' + fVersion + ')', 1);
                            io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                            // Start intervall for status queries
                            statusLoop = setInterval(function () {
                                if (isConnected) {
                                    if (!reprapWaitForPos && reprapBufferSize > 0) {
                                        reprapWaitForPos = true;
                                        machineSend('M114\n'); // query position
                                        reprapBufferSize--;
                                        writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                                    }
                                }
                            }, 250);
                        } else if (data.indexOf('FIRMWARE_NAME:MK') >= 0) { // Check if it's MarlinKimbra
                            firmware = 'marlinkimbra';
                            var startPos = data.search(/mk_/i) + 3;
                            fVersion = data.substr(startPos, 5); // get version
                            fDate = '';
                            writeLog('MarlinKimbra detected (' + fVersion + ')', 1);
                            io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                            // Start intervall for status queries
                            statusLoop = setInterval(function () {
                                if (isConnected) {
                                    if (!reprapWaitForPos && reprapBufferSize > 0) {
                                        reprapWaitForPos = true;
                                        machineSend('M114\n'); // query position
                                        reprapBufferSize--;
                                        writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                                    }
                                }
                            }, 250);
                        } else if (data.indexOf('FIRMWARE_NAME:Marlin') >= 0) { // Check if it's Marlin
                            firmware = 'marlin';
                            var startPos = data.search(/marlin_/i) + 7;
                            fVersion = data.substr(startPos, 5); // get version
                            fDate = '';
                            writeLog('Marlin detected (' + fVersion + ')', 1);
                            io.sockets.emit('firmware', { firmware: firmware, version: fVersion, date: fDate });
                            // Start intervall for status queries
                            statusLoop = setInterval(function () {
                                if (isConnected) {
                                    if (!reprapWaitForPos && reprapBufferSize >= 0) {
                                        reprapWaitForPos = true;
                                        machineSend('M114\n'); // query position
                                        reprapBufferSize--;
                                        writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                                    }
                                }
                            }, 250);
                        } else if (data.indexOf('FIRMWARE_NAME: RepRapFirmware') >= 0) { // Check if it's RepRapFirmware
                            firmware = 'reprapfirmware';
                            var startPos = data.search(/firmware_version:/i) + 18;
                            fVersion = data.substr(startPos, 7); // get version
                            startPos = data.search(/firmware_date:/i) + 16;
                            fDate = new Date(data.substr(startPos, 12));
                            REPRAP_RX_BUFFER_SIZE = 5;
                            reprapBufferSize = REPRAP_RX_BUFFER_SIZE;
                            writeLog('RepRapFirmware detected (' + fVersion + ')', 1);
                            io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                            // Start intervall for status queries
                            statusLoop = setInterval(function () {
                                if (isConnected) {
                                    if (!reprapWaitForPos && reprapBufferSize >= 0) {
                                        reprapWaitForPos = true;
                                        machineSend('M114\n'); // query position
                                        reprapBufferSize--;
                                        writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                                    }
                                }
                            }, 250);
                        } else if (data.indexOf('ALARM') === 0) { //} || data.indexOf('HALTED') === 0) {
                            switch (firmware) {
                            case 'grbl':
                                var alarmCode = parseInt(data.split(':')[1]);
                                writeLog('ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode));
                                io.sockets.emit('data', 'ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode));
                                break;
                            case 'smoothie':
                            case 'tinyg':
                            case 'repetier':
                            case 'marlinkimbra':
                            case 'marlin':
                            case 'reprapfirmware':
                                io.sockets.emit('data', data);
                                break;
                            }
                        } else if (data.indexOf('wait') === 0) { // Got wait from Repetier -> ignore
                            // do nothing
                        } else if (data.indexOf('Resend') === 0) { // Got resend from Repetier -> TODO: resend corresponding line!!!
                            switch (firmware) {
                            case 'repetier':
                            case 'marlinkimbra':
                            case 'marlin':
                            case 'reprapfirmware':
                                break;
                            }
                        } else if (data.indexOf('error') === 0) { // Error received -> stay blocked stops queue
                            switch (firmware) {
                            case 'grbl':
                                grblBufferSize.shift();
                                var errorCode = parseInt(data.split(':')[1]);
                                writeLog('error: ' + errorCode + ' - ' + grblStrings.errors(errorCode));
                                io.sockets.emit('data', 'error: ' + errorCode + ' - ' + grblStrings.errors(errorCode));
                                break;
                            case 'smoothie':
                            case 'tinyg':
                            case 'repetier':
                            case 'marlinkimbra':
                            case 'marlin':
                            case 'reprapfirmware':
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
                espSocket = new WebSocket('ws://'+connectedIp+'/', {
                    protocolVersion: 13,
                }); // connect to ESP websocket

                io.sockets.emit('connectStatus', 'opening:' + connectedIp);

                // ESP socket events -----------------------------------------------
                espSocket.on('open', function (e) {
                    io.sockets.emit('activeIP', connectedIp);
                    io.sockets.emit('connectStatus', 'opened:' + connectedIp);
                    if (reset) {
                        machineSend(String.fromCharCode(0x18)); // ctrl-x (reset firmware)
                        writeLog('Sent: ctrl-x', 1);
                    } else {
                        machineSend('\n'); // this causes smoothie to send the welcome string
                        writeLog('Sent: \\n', 1);
                    }
                    setTimeout(function () { //wait for controller to be ready
                        if (!firmware) { // Grbl should be already detected
                            machineSend('version\n'); // Check if it's Smoothieware?
                            writeLog('Sent: version', 2);
                            setTimeout(function () {  // Wait for Smoothie to answer
                                if (!firmware) {     // If still not set
                                    machineSend('{fb:n}\n'); // Check if it's TinyG
                                    writeLog('Sent: {fb:n}', 2);
                                    setTimeout(function () {  // Wait for TinyG to answer
                                        if (!firmware) {     // If still not set
                                            machineSend('M115\n'); // Check if it's RepRap Printers
                                            reprapBufferSize--;
                                            writeLog('Sent: M115', 2);
                                        }
                                    }, config.tinygWaitTime * 1000);
                                }
                            }, config.smoothieWaitTime * 1000);
                        }
                    }, config.grblWaitTime * 1000);
                    if (config.firmwareWaitTime > 0) {
                        setTimeout(function () {
                            // Close port if we don't detect supported firmware after 2s.
                            if (!firmware) {
                                writeLog('No supported firmware detected. Closing connection to ' + connectedTo, 1);
                                io.sockets.emit('data', 'No supported firmware detected. Closing connection to ' + connectedTo);
                                io.sockets.emit('connectStatus', 'closing:' + connectedTo);
                                gcodeQueue.length = 0; // dump the queye
                                grblBufferSize.length = 0; // dump bufferSizes
                                tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
                                reprapBufferSize = REPRAP_RX_BUFFER_SIZE; // reset reprapBufferSize
                                reprapWaitForPos = false;
                                clearInterval(queueCounter);
                                clearInterval(statusLoop);
                                espSocket.close();
                            }
                        }, config.firmwareWaitTime * 1000);
                    }

                    writeLog(chalk.yellow('INFO: ') + chalk.blue('ESP connected @ ' + connectedIp), 1);
                    isConnected = true;
                    connectedTo = connectedIp;
                    //machineSend(String.fromCharCode(0x18));
                });

                espSocket.on('close', function (e) {
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

                espSocket.on('error', function (e) {
                    io.sockets.emit('error', e.message);
                    io.sockets.emit('connectStatus', 'closed:');
                    io.sockets.emit('connectStatus', 'Connect');
                    writeLog(chalk.red('ESP ERROR: ') + chalk.blue(e.message), 1);
                });

                espSocket.on('message', function (msg) {
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
                                if (firmware === 'repetier' || firmware === 'marlinkimbra' || firmware === 'marlin' || firmware === 'reprapfirmware') {
                                    reprapBufferSize++;
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
                                    wPos = data.replace('>', '').substr(startWPos).split(/,|\|/, 4);
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
                                    if (aPos !== parseFloat(wPos[3]).toFixed(config.posDecimals)) {
                                        aPos = parseFloat(wPos[3]).toFixed(config.posDecimals);
                                        send = true;
                                    }
                                    if (send) {
                                        io.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos, a: aPos});
                                        setMpgWPos({x: xPos, y: yPos, z: zPos, a: aPos});
                                    }
                                }
                                // Extract mPos (for smoothieware only!)
                                var startMPos = data.search(/mpos:/i) + 5;
                                var mPos;
                                if (startMPos > 5) {
                                    mPos = data.replace('>', '').substr(startMPos).split(/,|\|/, 4);
                                }
                                if (Array.isArray(mPos)) {
                                    var send = false;
                                    if (xOffset !== parseFloat(mPos[0] - xPos).toFixed(config.posDecimals)) {
                                        xOffset = parseFloat(mPos[0] - xPos).toFixed(config.posDecimals);
                                        send = true;
                                    }
                                    if (yOffset !== parseFloat(mPos[1] - yPos).toFixed(config.posDecimals)) {
                                        yOffset = parseFloat(mPos[1] - yPos).toFixed(config.posDecimals);
                                        send = true;
                                    }
                                    if (zOffset !== parseFloat(mPos[2] - zPos).toFixed(config.posDecimals)) {
                                        zOffset = parseFloat(mPos[2] - zPos).toFixed(config.posDecimals);
                                        send = true;
                                    }
                                    if (aOffset !== parseFloat(mPos[3] - aPos).toFixed(config.posDecimals)) {
                                        aOffset = parseFloat(mPos[3] - aPos).toFixed(config.posDecimals);
                                        send = true;
                                    }
                                    if (send) {
                                        io.sockets.emit('wOffset', {x: xOffset, y: yOffset, z: zOffset, a: aOffset});
                                    }
                                }
                                // Extract work offset (for Grbl > 1.1 only!)
                                var startWCO = data.search(/wco:/i) + 4;
                                var wco;
                                if (startWCO > 4) {
                                    wco = data.replace('>', '').substr(startWCO).split(/,|\|/, 4);
                                }
                                if (Array.isArray(wco)) {
                                    xOffset = parseFloat(wco[0]).toFixed(config.posDecimals);
                                    yOffset = parseFloat(wco[1]).toFixed(config.posDecimals);
                                    zOffset = parseFloat(wco[2]).toFixed(config.posDecimals);
                                    aOffset = parseFloat(wco[3]).toFixed(config.posDecimals);
                                    if (send) {
                                        io.sockets.emit('wOffset', {x: xOffset, y: yOffset, z: zOffset, a: aOffset});
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
                            } else if (data.indexOf('X') === 0) {   // Extract wPos for RepRap Printers
                                var pos;
                                var startPos = data.search(/x:/i) + 2;
                                if (startPos >= 2) {
                                    pos = data.substr(startPos, 4);
                                    if (xPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                                        xPos = parseFloat(pos).toFixed(config.posDecimals);
                                    }
                                }
                                var startPos = data.search(/y:/i) + 2;
                                if (startPos >= 2) {
                                    pos = data.substr(startPos, 4);
                                    if (yPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                                        yPos = parseFloat(pos).toFixed(config.posDecimals);
                                    }
                                }
                                var startPos = data.search(/z:/i) + 2;
                                if (startPos >= 2) {
                                    pos = data.substr(startPos, 4);
                                    if (zPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                                        zPos = parseFloat(pos).toFixed(config.posDecimals);
                                    }
                                }
                                var startPos = data.search(/e:/i) + 2;
                                if (startPos >= 2) {
                                    pos = data.substr(startPos, 4);
                                    if (aPos !== parseFloat(pos).toFixed(config.posDecimals)) {
                                        aPos = parseFloat(pos).toFixed(config.posDecimals);
                                    }
                                }
                                io.sockets.emit('wPos', {x: xPos, y: yPos, z: zPos, a: aPos});
                                setMpgWPos({x: xPos, y: yPos, z: zPos, a: aPos});
                                //writeLog('wPos: X:' + xPos + ' Y:' + yPos + ' Z:' + zPos + ' E:' + aPos, 3);
                                reprapWaitForPos = false;
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
                            } else if (data.indexOf('start') === 0) { // Check if it's RepRap
                                machineSend('M115\n'); // Check if it's Repetier or MarlinKimbra
                                reprapBufferSize--;
                                writeLog('Sent: M115', 2);
                            } else if (data.indexOf('FIRMWARE_NAME:Repetier') >= 0) { // Check if it's Repetier
                                firmware = 'repetier';
                                var startPos = data.search(/repetier_/i) + 9;
                                fVersion = data.substr(startPos, 4); // get version
                                fDate = '';
                                writeLog('Repetier detected (' + fVersion + ')', 1);
                                io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                                // Start intervall for status queries
                                statusLoop = setInterval(function () {
                                    if (isConnected) {
                                        if (!reprapWaitForPos && reprapBufferSize > 0) {
                                            reprapWaitForPos = true;
                                            machineSend('M114\n'); // query position
                                            reprapBufferSize--;
                                            writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                                        }
                                    }
                                }, 250);
                            } else if (data.indexOf('FIRMWARE_NAME:MK') >= 0) { // Check if it's MarlinKimbra
                                firmware = 'marlinkimbra';
                                var startPos = data.search(/mk_/i) + 3;
                                fVersion = data.substr(startPos, 5); // get version
                                fDate = '';
                                writeLog('MarlinKimbra detected (' + fVersion + ')', 1);
                                io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                                // Start intervall for status queries
                                statusLoop = setInterval(function () {
                                    if (isConnected) {
                                        if (!reprapWaitForPos && reprapBufferSize > 0) {
                                            reprapWaitForPos = true;
                                            machineSend('M114\n'); // query position
                                            reprapBufferSize--;
                                            writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                                        }
                                    }
                                }, 250);
                            } else if (data.indexOf('FIRMWARE_NAME:Marlin') >= 0) { // Check if it's MarlinKimbra
                                firmware = 'marlin';
                                var startPos = data.search(/marlin_/i) + 7;
                                fVersion = data.substr(startPos, 5); // get version
                                fDate = '';
                                writeLog('Marlin detected (' + fVersion + ')', 1);
                                io.sockets.emit('firmware', { firmware: firmware, version: fVersion, date: fDate });
                                // Start intervall for status queries
                                statusLoop = setInterval(function () {
                                    if (isConnected) {
                                        if (!reprapWaitForPos && reprapBufferSize >= 0) {
                                            reprapWaitForPos = true;
                                            machineSend('M114\n'); // query position
                                            reprapBufferSize--;
                                            writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                                        }
                                    }
                                }, 250);
                            }else if (data.indexOf('FIRMWARE_NAME: RepRapFirmware') >= 0) { // Check if it's RepRapFirmware
                                firmware = 'reprapfirmware';
                                var startPos = data.search(/firmware_version:/i) + 17;
                                fVersion = data.substr(startPos, 5); // get version
                                startPos = data.search(/firmware_date:/i) + 15;
                                fDate = new Date(data.substr(startPos, 10));
                                writeLog('RepRapFirmware detected (' + fVersion + ')', 1);
                                io.sockets.emit('firmware', {firmware: firmware, version: fVersion, date: fDate});
                                // Start intervall for status queries
                                statusLoop = setInterval(function () {
                                    if (isConnected) {
                                        if (!reprapWaitForPos && reprapBufferSize >= 0) {
                                            reprapWaitForPos = true;
                                            machineSend('M114\n'); // query position
                                            reprapBufferSize--;
                                            writeLog('Sent: M114 (B' + reprapBufferSize + ')', 2);
                                        }
                                    }
                                }, 250);
                            } else if (data.indexOf('{') === 0) { // JSON response (probably TinyG)
                                try {
                                    var jsObject = JSON.parse(data);
                                } catch(err) {
                                    console.error('Recieved invalid JSON response on connection:')
                                    console.error(data)
                                    var jsObject = "{}"
                                }
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
                                    if (jsObject.sr.posx) {
                                        xPos = parseFloat(jsObject.sr.posx).toFixed(4);
                                    }
                                    if (jsObject.sr.posy) {
                                        yPos = parseFloat(jsObject.sr.posy).toFixed(4);
                                    }
                                    if (jsObject.sr.posz) {
                                        zPos = parseFloat(jsObject.sr.posz).toFixed(4);
                                    }
                                    if (jsObject.sr.posa) {
                                        aPos = parseFloat(jsObject.sr.posa).toFixed(4);
                                    }
                                    io.sockets.emit('wPos', xPos + ',' + yPos + ',' + zPos + ',' + aPos);
                                    setMpgWPos({x: xPos, y: yPos, z: zPos, a: aPos});
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
                                    var alarmCode = parseInt(data.split(':')[1]);
                                    writeLog('ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode));
                                    io.sockets.emit('data', 'ALARM: ' + alarmCode + ' - ' + grblStrings.alarms(alarmCode));
                                    break;
                                case 'smoothie':
                                case 'tinyg':
                                case 'repetier':
                                case 'marlinkimbra':
                                case 'marlin':
                                case 'reprapfirmware':
                                    io.sockets.emit('data', data);
                                    break;
                                }
                            } else if (data.indexOf('wait') === 0) { // Got wait from Repetier -> ignore
                                // do nothing
                            } else if (data.indexOf('Resend') === 0) { // Got resend from Repetier -> TODO: resend corresponding line!!!
                                switch (firmware) {
                                case 'repetier':
                                case 'marlinkimbra':
                                case 'marlin':
                                case 'reprapfirmware':
                                    break;
                                }
                            } else if (data.indexOf('error') === 0) { // Error received -> stay blocked stops queue
                                switch (firmware) {
                                case 'grbl':
                                    grblBufferSize.shift();
                                    var errorCode = parseInt(data.split(':')[1]);
                                    writeLog('error: ' + errorCode + ' - ' + grblStrings.errors(errorCode));
                                    io.sockets.emit('data', 'error: ' + errorCode + ' - ' + grblStrings.errors(errorCode));
                                    break;
                                case 'smoothie':
                                case 'tinyg':
                                case 'repetier':
                                case 'marlinkimbra':
                                case 'marlin':
                                case 'reprapfirmware':
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
        runJob(data);
    });

    appSocket.on('runMacro', function (data) {
        runMacro(data);
    });

    appSocket.on('runCommand', function (data) {
        runCommand(data);
    });

    appSocket.on('jog', function (data) {
        data = data.split(',');
        var dir = data[0];
        var dist = parseFloat(data[1]);
        var feed = '';
        if (data.length > 2) {
            feed = parseInt(data[2]);
        }
        jog({dir: dir, dist: dist, feed: feed});
    });

    appSocket.on('jogTo', function (data) {     
        jogTo(data);
    });

    appSocket.on('setZero', function (data) {
        setZero(data);
    });

    appSocket.on('gotoZero', function (data) {
        gotoZero(data);
    });

    appSocket.on('setPosition', function (data) {
        setPosition(data);
    });

    appSocket.on('home', function (data) {
        var err = home(data);
        if (err) {
            appSocket.emit('error', err);
        }
    });

    appSocket.on('probe', function (data) {
        var err = probe(data);
        if (err) {
            appSocket.emit('error', err);
        }
    });
    
    appSocket.on('feedOverride', function (data) {
        var err = feedOv(data);
        if (err) {
            appSocket.emit('error', err);
        }
    });

    appSocket.on('spindleOverride', function (data) {
        var err = spindleOv(data);
        if (err) {
            appSocket.emit('error', err);
        }
    });

    appSocket.on('laserTest', function (data) { // Laser Test Fire
        laserTest(data);
    });

    appSocket.on('pause', function () {
        pauseMachine();
    });

    appSocket.on('resume', function () {
        resumeMachine();
    });

    appSocket.on('stop', function () {
        stopMachine();
    });

    appSocket.on('clearAlarm', function (data) { // Clear Alarm
        clearAlarm(data);
    });
    
    appSocket.on('resetMachine', function () {
        resetMachine();
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
                reprapBufferSize = REPRAP_RX_BUFFER_SIZE; // reset reprapBufferSize
                reprapWaitForPos = false;
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
                reprapBufferSize = REPRAP_RX_BUFFER_SIZE; // reset reprapBufferSize
                reprapWaitForPos = false;
                clearInterval(queueCounter);
                clearInterval(statusLoop);
                telnetSocket.destroy();
                break;
            case 'esp8266':
                writeLog(chalk.yellow('WARN: ') + chalk.blue('Closing ESP @ ' + connectedIp), 1);
                io.sockets.emit("connectStatus", 'closing:' + connectedIp);
                //machineSend(String.fromCharCode(0x18)); // ctrl-x
                gcodeQueue.length = 0; // dump the queye
                grblBufferSize.length = 0; // dump bufferSizes
                tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
                reprapBufferSize = REPRAP_RX_BUFFER_SIZE; // reset reprapBufferSize
                reprapWaitForPos = false;
                clearInterval(queueCounter);
                clearInterval(statusLoop);
                espSocket.close();
                break;
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
        }
    });

    appSocket.on('disconnect', function (data) { // App disconnected
        data = data.replace('namespace ','')  // make disconnect reasons easier to comprehend
        data = data.replace('transport','connection')
        let id = connections.indexOf(appSocket);
        writeLog(chalk.yellow('App disconnected! (id=' + id + ', reason: ' + data + ')'), 1);
        connections.splice(id, 1);
    });

        
    appSocket.on('sd.list', function () {  // List SD content
        if (isConnected) {
            writeLog(chalk.red('sd.list'), 1);
            switch (firmware) {
            case 'smoothie':
                machineSend('ls/n');
                writeLog('Sent: ls', 2);
                break;
            case 'repetier':
                break;
            case 'marlin':
            case 'marlinkimbra':
                machineSend('M20/n');
                writeLog('Sent: M20', 2);
                break;
            case 'reprapfirmware':
                machineSend('M20 S2/n');
                writeLog('Sent: M20 S2', 2);
                break;
            }
        }
    });

    appSocket.on('sd.cd', function (data) {  // Change directory
        if (isConnected) {
            writeLog(chalk.red('sd.cd'), 1);
            switch (firmware) {
            case 'smoothie':
                machineSend('cd ' + data + '/n');
                writeLog('Sent: cd', 2);
                break;
            case 'repetier':
                break;
            case 'marlin':
            case 'marlinkimbra':
            case 'reprapfirmware':
                sdFolder = data;    // not finished!
                break;
            }
        }
    });

    appSocket.on('sd.rm', function (data) {  // Delete file
        if (isConnected) {
            writeLog(chalk.red('sd.rm'), 1);
            switch (firmware) {
            case 'smoothie':
                machineSend('rm ' + data + '/n');
                writeLog('Sent: rm', 2);
                break;
            case 'repetier':
                break;
            case 'marlin':
            case 'marlinkimbra':
            case 'reprapfirmware':
                machineSend('M30 ' + data + '/n');
                writeLog('Sent: rm', 2);
                break;
            }
        }
    });

    appSocket.on('sd.mv', function (data) {  // Rename/move file
        if (isConnected) {
            writeLog(chalk.red('sd.mv'), 1);
            switch (firmware) {
            case 'smoothie':
                machineSend('mv ' + data.file + ' ' + data.newfile + '/n');
                writeLog('Sent: mv', 2);
                break;
            case 'repetier':
                break;
            case 'marlin':
            case 'marlinkimbra':
            case 'reprapfirmware':
                break;
            }
        }
    });

    appSocket.on('sd.play', function (data) {  // Play file
        if (isConnected) {
            writeLog(chalk.red('sd.play'), 1);
            switch (firmware) {
            case 'smoothie':
                machineSend('play ' + data + '/n');
                writeLog('Sent: play', 2);
                break;
            case 'repetier':
                break;
            case 'marlin':
            case 'marlinkimbra':
            case 'reprapfirmware':
                machineSend('M23 ' + data + '/n');
                writeLog('Sent: M23', 2);
                machineSend('M24/n');
                writeLog('Sent: M24', 2);
                break;
            }
        }
    });

    appSocket.on('sd.pause', function () {  // Abort SD print
        if (isConnected) {
            writeLog(chalk.red('sd.abort'), 1);
            switch (firmware) {
            case 'smoothie':
                machineSend('suspend/n');
                writeLog('Sent: suspend', 2);
                break;
            case 'repetier':
                break;
            case 'marlin':
            case 'marlinkimbra':
            case 'reprapfirmware':
                machineSend('M25/n');
                writeLog('Sent: M25', 2);
                break;
            }
        }
    });

    appSocket.on('sd.resume', function () {  // Resume SD print
        if (isConnected) {
            writeLog(chalk.red('sd.resume'), 1);
            switch (firmware) {
            case 'smoothie':
                machineSend('resume/n');
                writeLog('Sent: resume', 2);
                break;
            case 'repetier':
                break;
            case 'marlin':
            case 'marlinkimbra':
            case 'reprapfirmware':
                machineSend('M24/n');
                writeLog('Sent: M24', 2);
                break;
            }
        }
    });

    appSocket.on('sd.abort', function () {  // Abort SD print
        if (isConnected) {
            writeLog(chalk.red('sd.abort'), 1);
            switch (firmware) {
            case 'smoothie':
                machineSend('abort/n');
                writeLog('Sent: abort', 2);
                break;
            case 'marlin':
            case 'marlinkimbra':
            case 'reprapfirmware':
                machineSend('M112/n');
                writeLog('Sent: M112', 2);
                break;
            case 'repetier':
                break;
            }
        }
    });

    appSocket.on('sd.upload', function (data) {  // Upload file to SD
        if (isConnected) {
            writeLog(chalk.red('sd.upload'), 1);
            switch (firmware) {
            case 'smoothie':
                machineSend('upload ' + data.filename + '' + data.gcode + '/n');
                writeLog('Sent: upload', 2);
                break;
            case 'marlin':
            case 'marlinkimbra':
            case 'reprapfirmware':
                machineSend('M28 ' + data.filename + '/n');
                writeLog('Sent: M28 ' + data.filename, 2);
                machineSend(data.gcode + '/n');
                machineSend('M29 ' + data.filename + '/n');
                writeLog('Sent: M29 ' + data.filename, 2);
                break;
            case 'repetier':
                break;
            }
        }
    });

    appSocket.on('sd.progress', function (data) {  // Get SD print progress
        if (isConnected) {
            writeLog(chalk.red('sd.progtress'), 1);
            switch (firmware) {
            case 'smoothie':
                machineSend('progress/n');
                writeLog('Sent: progress', 2);
                break;
            case 'marlin':
            case 'marlinkimbra':
            case 'reprapfirmware':
                machineSend('M27/n');
                writeLog('Sent: M27', 2);
                break;
            case 'repetier':
                break;
            }
        }
    });

}); 

// End appSocket


function runJob(data) {
    writeLog('Run Job (' + data.length + ')', 1);
    if (isConnected) {
        if (data) {
            runningJob = data;
            //jobRequestIP = appSocket.request.connection.remoteAddress;
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
                        } else if (tosend.indexOf('A') === 0) {
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

                //NAB - Added to support action to run befor job starts
                doJobAction(config.jobOnStart);

                send1Q();
            }
        }
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }
}

function runMacro(data) {
    writeLog(chalk.red('Run Macro (' + data + ')'), 1);
    if (isConnected) {
        if (macro[data]) {
            data = macro[data].split('\n');
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
}

function runCommand(data) {
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
}

function jog(data) {
    // data: direction, distance, feed
    var dir = data.dir;
    var dist = data.dist;
    var feed = '';
    if (data.feed){
        feed = parseInt(data.feed);
        if (feed) {
            feed = 'F' + feed;   
        }
    }
    writeLog(chalk.red('Jog ' + data), 1);
    if (isConnected) {
        if (dir && dist && feed) {
            writeLog('Adding jog commands to queue. blocked=' + blocked + ', paused=' + paused + ', Q=' + gcodeQueue.length, 1);
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
            case 'repetier':
            case 'marlinkimbra':
                addQ('G91');
                addQ('G0 ' + feed + dir + dist);
                addQ('G90');
                send1Q();
                break;
            case 'marlin':
                addQ('G91');
                addQ('G0 ' + feed +" "+ dir +" "+ dist);
                addQ('G90');
                send1Q();
                break;
            case 'reprapfirmware':
                addQ('M120');
                addQ('G91');
                addQ('G1 ' + dir + dist +" "+ feed);
                addQ('M121');
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
}

function jogTo(data) {     // data = {x:xVal, y:yVal, z:zVal, mode:0(absulute)|1(relative), feed:fVal}
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
            case 'repetier':
            case 'marlinkimbra':
                addQ('G9' + mode);
                addQ('G0' + feed + xVal + yVal + zVal);
                addQ('G90');
                send1Q();
                break;
            case 'marlin':
                addQ('G9' + mode);
                addQ('G0 ' + feed +" "+ xVal +" "+ yVal +" "+ zVal);
                addQ('G90');
                send1Q();
                break;
            case 'reprapfirmware':
                addQ('M120');
                addQ('G9' + mode);
                addQ('G1 ' + feed +" "+ xVal +" "+ yVal +" "+ zVal);
                addQ('G90');
                addQ('M121');
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
}

function setZero(data) {
    writeLog(chalk.red('setZero(' + data + ')'), 1);
    if (isConnected) {
        switch (data) {
        case 'x':
            if (firmware == "marlin" || firmware == "reprapfirmware")
                addQ('G92 X0');
            else
                addQ('G10 L20 P0 X0');
            break;
        case 'y':
            if (firmware == "marlin" || firmware == "reprapfirmware")
                addQ('G92 Y0');
            else
                addQ('G10 L20 P0 Y0');
            break;
        case 'z':
            if (firmware == "marlin" || firmware == "reprapfirmware")
                addQ('G92 Z0');
            else
                addQ('G10 L20 P0 Z0');
            break;
        case 'a':
            if (firmware == "marlin" || firmware == "reprapfirmware")
                addQ('G92 E0');
            else
                addQ('G10 L20 P0 A0');
            break;
        case 'all':
            switch (firmware) {
            case 'repetier':
                addQ('G92');
                break;
            case 'marlinkimbra':
            case 'marlin':
            case 'reprapfirmware':
                addQ('G92 X0 Y0 Z0');
                break;
            default:
                addQ('G10 L20 P0 X0 Y0 Z0');
                break;
            }
            break;
        case 'xyza':
            if (firmware == "marlin" || firmware == "reprapfirmware")
                addQ('G92 X0 Y0 Z0 E0');
            else
                addQ('G10 L20 P0 X0 Y0 Z0 A0');
            break;
        }
        send1Q();
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }
}

function gotoZero(data) {
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
        case 'a':
            addQ('G0 A0');
            break;
        case 'all':
            addQ('G0 X0 Y0 Z0');
            break;
        case 'xyza':
            addQ('G0 X0 Y0 Z0 A0');
            break;
        }
        send1Q();
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }
}

function setPosition(data) {
    writeLog(chalk.red('setPosition(' + JSON.stringify(data) + ')'), 1);
    if (isConnected) {
        if (data.x !== undefined || data.y !== undefined || data.z !== undefined) {
            var xVal = (data.x !== undefined ? 'X' + parseFloat(data.x) + ' ' : '');
            var yVal = (data.y !== undefined ? 'Y' + parseFloat(data.y) + ' ' : '');
            var zVal = (data.z !== undefined ? 'Z' + parseFloat(data.z) + ' ' : '');
            var aVal = (data.a !== undefined ? 'A' + parseFloat(data.a) + ' ' : '');
            addQ('G10 L20 P0 ' + xVal + yVal + zVal + aVal);
            send1Q();
        }
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }
}

function home(data) {
    writeLog(chalk.red('home(' + data + ')'), 1);
    if (isConnected) {
        switch (data) {
        case 'x':
            switch (firmware) {
            case 'smoothie':
            case 'repetier':
            case 'marlinkimbra':
                addQ('G28.2 X');
                break;
            case 'tinyg':
                addQ('G28.2 X0');
                break;
            case 'marlin':
            case 'reprapfirmware':
                addQ('G28 X');
                break;
            default:
                //not supported
                appSocket.emit('error', 'Command not supported by firmware!');
                break;
            }
            break;
        case 'y':
            switch (firmware) {
            case 'smoothie':
            case 'repetier':
            case 'marlinkimbra':
                addQ('G28.2 Y');
                break;
            case 'marlin':
            case 'reprapfirmware':
                addQ('G28 Y');
                break;
            case 'tinyg':
                addQ('G28.2 Y0');
                break;
            default:
                //not supported
                appSocket.emit('error', 'Command not supported by firmware!');
                break;
            }
            break;
        case 'z':
            switch (firmware) {
            case 'smoothie':
            case 'repetier':
            case 'marlinkimbra':
                addQ('G28.2 Z');
                break;
            case 'marlin':
            case 'reprapfirmware':
                addQ('G28 Z');
                break;
            case 'tinyg':
                addQ('G28.2 Z0');
                break;
            default:
                //not supported
                appSocket.emit('error', 'Command not supported by firmware!');
                break;
            }
            break;
        case 'a':
            switch (firmware) {
            case 'smoothie':
            case 'repetier':
            case 'marlinkimbra':
                addQ('G28.2 E1');
                break;
            case 'marlin':
                addQ('G28 E1'); // ????
                break;
            case 'tinyg':
                addQ('G28.2 A0');
                break;
            default:
                //not supported
                appSocket.emit('error', 'Command not supported by firmware!');
                break;
            }
            break;
        case 'all': // XYZ only!!
            switch (firmware) {
            case 'grbl':
                addQ('$H');
                break;
            case 'smoothie':
            case 'repetier':
            case 'marlinkimbra':
                addQ('G28.2 X Y Z');
                break;
            case 'marlin':
            case 'reprapfirmware':
                addQ('G28 X Y Z');
                break;
            case 'tinyg':
                addQ('G28.2 X0 Y0 Z0');
                break;
            default:
                //not supported
                appSocket.emit('error', 'Command not supported by firmware!');
                break;
            }
            break;
        case 'xyza':
            switch (firmware) {
            case 'grbl':
                addQ('$H');
                break;
            case 'smoothie':
            case 'repetier':
            case 'marlinkimbra':
                addQ('G28.2 X Y Z E');
                break;
            case 'marlin':
            case 'reprapfirmware':
                addQ('G28 X Y Z E');
                break;
            case 'tinyg':
                addQ('G28.2 X0 Y0 Z0 A0');
                break;
            default:
                //not supported
                appSocket.emit('error', 'Command not supported by firmware!');
                break;
            }
            break;
        }
        send1Q();
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }
}

function probe(data) {
    writeLog(chalk.red('probe(' + JSON.stringify(data) + ')'), 1);
    if (isConnected) {
        switch (firmware) {
        case 'smoothie':
            switch (data.direction) {
            case 'z':
                addQ('G30 Z' + data.probeOffset);
                break;
            default:
                addQ('G38.2 ' + data.direction);
                break;
            }
            break;
        case 'grbl':
            addQ('G38.2 ' + data.direction + '-5 F1');
            addQ('G92 ' + data.direction + ' ' + data.probeOffset);
            break;
        case 'repetier':
        case 'marlinkimbra':
            addQ('G38.2 ' + data.direction + '-5 F1');
            break;
        case 'reprapfirmware':
            switch (data.direction) {
            case 'z':
                addQ('G30');
                break;
            }
            break;
        default:
            //not supported
            appSocket.emit('error', 'Command not supported by firmware!');
            break;
        }
        send1Q();
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }
}

function feedOv(data) {
    if (isConnected) {
        switch (firmware) {
        case 'grbl':
            var code;
            switch (data) {
            case 0:
                code = 144; // set to 100%
                data = '100';
                feedOverride = data;
                break;
            case 10:
                code = 145; // +10%
                data = '+' + data;
                feedOverride += 10;
                break;
            case -10:
                code = 146; // -10%
                feedOverride -= 10;
                break;
            case 1:
                code = 147; // +1%
                data = '+' + data;
                feedOverride += 1;
                break;
            case -1:
                code = 148; // -1%
                feedOverride -= 1;
                break;
            }
            if (code) {
                //jumpQ(String.fromCharCode(parseInt(code)));
                machineSend(String.fromCharCode(parseInt(code)));
                writeLog('Sent: Code(' + code + ')', 2);
                writeLog(chalk.red('Feed Override ' + data + '% (=' + feedOverride + ')'), 1);
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
            writeLog(chalk.red('Feed Override ' + feedOverride.toString() + '% (=' + feedOverride + ')'), 1);
            //send1Q();
            break;
        case 'tinyg':
            break;
        case 'repetier':
        case 'marlinkimbra':
        case 'reprapfirmware':
            if (data === 0) {
                feedOverride = 100;
            } else {
                if ((feedOverride + data <= 200) && (feedOverride + data >= 10)) {
                    // valid range is 10..200, else ignore!
                    feedOverride += data;
                }
            }
            machineSend('M220 S' + feedOverride + '\n');
            reprapBufferSize--;
            writeLog('Sent: M220 S' + feedOverride, 2);
            io.sockets.emit('feedOverride', feedOverride);
            writeLog(chalk.red('Feed Override ' + feedOverride.toString() + '%'), 1);
            break;
        }
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }
}

function spindleOv(data) {
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
                spindleOverride += 10;
                break;
            case -10:
                code = 155; // -10%
                spindleOverride -= 10;
                break;
            case 1:
                code = 156; // +1%
                data = '+' + data;
                spindleOverride += 1;
                break;
            case -1:
                code = 157; // -1%
                spindleOverride -= 1;
                break;
            }
            if (code) {
                //jumpQ(String.fromCharCode(parseInt(code)));
                machineSend(String.fromCharCode(parseInt(code)));
                writeLog('Sent: Code(' + code + ')', 2);
                writeLog(chalk.red('Spindle (Laser) Override ' + data + '% (=' + spindleOverride + ')'), 1);
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
        case 'repetier':
        case 'marlinkimbra':
        case 'reprapfirmware':
            if (data === 0) {
                spindleOverride = 100;
            } else {
                if ((spindleOverride + data <= 200) && (spindleOverride + data >= 0)) {
                    // valid range is 0..200, else ignore!
                    spindleOverride += data;
                }
            }
            machineSend('M221 S' + spindleOverride + '\n');
            reprapBufferSize--;
            writeLog('Sent: M221 S' + spindleOverride, 2);
            io.sockets.emit('spindleOverride', spindleOverride);
            writeLog(chalk.red('Spindle (Laser) Override ' + spindleOverride.toString() + '%'), 1);
            break;
        }
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }
}

function laserTest(data) { // Laser Test Fire
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
                        io.sockets.emit('laserTest', power);
                        if (duration > 0) {
                            addQ('G4 P' + duration / 1000);
                            addQ('M5S0');
                            laserTestOn = false;
                            //io.sockets.emit('laserTest', 0); //-> Grbl get the real state with status report
                        }
                        send1Q();
                        break;
                    case 'smoothie':
                        addQ('M3\n');
                        addQ('fire ' + power + '\n');
                        laserTestOn = true;
                        io.sockets.emit('laserTest', power);
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
                                io.sockets.emit('laserTest', 0);
                            }, duration );
                        }
                        send1Q();
                        break;
                    case 'tinyg':
                        addQ('G1F1');
                        addQ('M3S' + parseInt(power * maxS / 100));
                        laserTestOn = true;
                        io.sockets.emit('laserTest', power);
                        if (duration > 0) {
                            addQ('G4 P' + duration / 1000);
                            addQ('M5S0');
                            laserTestOn = false;
                            setTimeout(function () {
                                laserTestOn = false;
                                io.sockets.emit('laserTest', 0);
                            }, duration );
                        }
                        send1Q();
                        break;
                    case 'repetier':
                    case 'marlinkimbra':
                        addQ('G1F1');
                        addQ('M3 S' + parseInt(power * maxS / 100));
                        addQ('M4');
                        laserTestOn = true;
                        io.sockets.emit('laserTest', power);
                        if (duration > 0) {
                            addQ('G4 P' + duration);
                            addQ('M5');
                            laserTestOn = false;
                            setTimeout(function () {
                                laserTestOn = false;
                                io.sockets.emit('laserTest', 0);
                            }, duration );
                        }
                        send1Q();
                        break;
                    case 'marlin':
                        addQ('G1 F1');
                        addQ('M106 S' + parseInt(power * maxS / 100));
                        laserTestOn = true;
                        io.sockets.emit('laserTest', power);
                        if (duration > 0) {
                            addQ('G4 P' + duration);
                            addQ('M107');
                            laserTestOn = false;
                            setTimeout(function () {
                                laserTestOn = false;
                                io.sockets.emit('laserTest', 0);
                            }, duration);
                        }
                        send1Q();
                        break;
                    case 'reprapfirmware':
                        addQ('G1 F1');
                        addQ('M106 S' + parseInt(power * maxS / 100));
                        laserTestOn = true;
                        io.sockets.emit('laserTest', power);
                        if (duration > 0) {
                            addQ('G4 P' + duration);
                            addQ('M106 S0');
                            laserTestOn = false;
                            setTimeout(function () {
                                laserTestOn = false;
                                io.sockets.emit('laserTest', 0);
                            }, duration);
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
                case 'repetier':
                case 'marlinkimbra':
                    addQ('M5');
                    send1Q();
                    break;
                case 'marlin':
                    addQ('M107');
                    send1Q();
                    break;
                case 'reprapfirmware':
                    addQ('M106 S0');
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
}

function pauseMachine() {
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
        case 'repetier':
        case 'marlinkimbra':
        case 'marlin':
            // just stop sending gcodes
            break;
        case 'reprapfirmware':
            // pause SD print and stop sending gcodes
            machineSend('M25'); // Send hold command
            writeLog('Sent: M25', 2);
            break;
        }
        io.sockets.emit('runStatus', 'paused');
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }
}

function resumeMachine() {
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
        case 'repetier':
        case 'marlinkimbra':
        case 'marlin':
            break;
        case 'reprapfirmware':
            // resume SD print (if used)
            machineSend('M24'); // Send resume command
            writeLog('Sent: M24', 2);
            break;
        }
        paused = false;
        send1Q(); // restart queue
        io.sockets.emit('runStatus', 'resumed');
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }
}

function stopMachine() {
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
        case 'repetier':
        case 'marlinkimbra':
        case 'marlin':
        case 'reprapfirmware':
            paused = true;
            machineSend('M112/n'); // abort
            writeLog('Sent: M112', 2);
            break;
        }
        clearInterval(queueCounter);
        io.sockets.emit('qCount', 0);
        gcodeQueue.length = 0; // Dump the Queye
        grblBufferSize.length = 0; // Dump bufferSizes
        tinygBufferSize = TINYG_RX_BUFFER_SIZE;  // reset tinygBufferSize
        reprapBufferSize = REPRAP_RX_BUFFER_SIZE; // reset reprapBufferSize
        reprapWaitForPos = false;
        queueLen = 0;
        queuePointer = 0;
        queuePos = 0;
        laserTestOn = false;
        startTime = null;
        runningJob = null;
        jobRequestIP = null;
        blocked = false;
        paused = false;
        io.sockets.emit('runStatus', 'stopped');

        //NAB - Added to support action to run after job aborts
        doJobAction(config.jobOnAbort);

    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }
}

function clearAlarm(data) { // Clear Alarm
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
                machineSend('~\n');
                writeLog('Sent: ~', 2);
                break;
            case 'tinyg':
                machineSend('$X\n');
                writeLog('Sent: $X', 2);
                break;
            case 'repetier':
            case 'marlinkimbra':
            case 'marlin':
            case 'reprapfirmware':
                machineSend('M112\n');
                writeLog('Sent: M112', 2);
                break;
            }
            writeLog('Resuming Queue Lockout', 1);
            break;
        case 2:
            writeLog('Emptying Queue', 1);
            gcodeQueue.length = 0; // Dump the Queye
            grblBufferSize.length = 0; // Dump bufferSizes
            tinygBufferSize = TINYG_RX_BUFFER_SIZE;  // reset tinygBufferSize
            reprapBufferSize = REPRAP_RX_BUFFER_SIZE; // reset reprapBufferSize
            reprapWaitForPos = false;
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
                machineSend('~\n');
                writeLog('Sent: ~', 2);
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
            case 'repetier':
            case 'marlinkimbra':
            case 'marlin':
            case 'reprapfirmware':
                machineSend('M112/n');
                writeLog('Sent: M112', 2);
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
}

function resetMachine() {
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
        case 'repetier':
        case 'marlinkimbra':
        case 'marlin':
        case 'reprapfirmware':
            machineSend('M112/n');
            writeLog('Sent: M112', 2);
            break;
        }
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'), 1);
    }
}


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
        telnetSocket.write(gcode);
        break;
    case 'esp8266':
        espSocket.send(gcode,{binary: false});
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
        case 'repetier':
        case 'marlinkimbra':
        case 'marlin':
            while (reprapBufferSize > 0 && gcodeQueue.length > 0 && !blocked && !paused) {
                gcode = gcodeQueue.shift();
                machineSend(gcode + '\n');
                reprapBufferSize--;
                writeLog('Sent: ' + gcode + ' Q: ' + gcodeQueue.length, 2);
            }
            break;
        case 'reprapfirmware':
            while (reprapBufferSize > 0 && gcodeQueue.length > 0 && !blocked && !paused) {
                gcode = gcodeQueue.shift();
                machineSend(gcode + '\n');
                reprapBufferSize--;
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
            speed = (queuePointer / elapsedTime);
            if (speed >= 100) speed = speed.toFixed(0);
            else speed = speed.toPrecision(3);
            let pct = ((queuePointer / queueLen) * 100).toFixed(1);
            writeLog('Done: ' + queuePointer + ' of ' + queueLen + ' (' + pct + '%, ave. ' + speed + ' lines/s)', 1);
        }
        if (queuePointer >= gcodeQueue.length) {
            clearInterval(queueCounter);
            io.sockets.emit('qCount', 0);
            if (startTime) {
                finishTime = new Date(Date.now());
                elapsedTimeMS = finishTime.getTime() - startTime.getTime();
                elapsedTime = Math.round(elapsedTimeMS / 1000);
                speed = (queuePointer / elapsedTime);
                if (speed >= 100) speed = speed.toFixed(0);
                else speed = speed.toPrecision(3);
                writeLog("Job started at " + startTime.toString(), 1);
                writeLog("Job finished at " + finishTime.toString(), 1);
                writeLog("Elapsed time: " + elapsedTime + " seconds.", 1);
                writeLog('Ave. Speed: ' + speed + ' lines/s', 1);
            }
            gcodeQueue.length = 0; // Dump the Queye
            grblBufferSize.length = 0; // Dump bufferSizes
            tinygBufferSize = TINYG_RX_BUFFER_SIZE;  // reset tinygBufferSize
            reprapBufferSize = REPRAP_RX_BUFFER_SIZE;  // reset tinygBufferSize
            queueLen = 0;
            queuePointer = 0;
            queuePos = 0;
            startTime = null;
            runningJob = null;
            jobRequestIP = null;
            io.sockets.emit('runStatus', 'finished');

			//NAB - Added to support action to run after job completes
            doJobAction(config.jobOnFinish);
        }
    } else {
        io.sockets.emit("connectStatus", 'closed');
        io.sockets.emit('connectStatus', 'Connect');
        writeLog(chalk.red('ERROR: ') + chalk.blue('Error while send1Q(): Machine connection not open!'), 2);
    }
}


//==========================
// MPG implementation start
//==========================

// MPG CMD Byte Packet Names
const MPG_CMD_START_BYTE = 0;
const MPG_CMD_BYTE1 = 1;
const MPG_CMD_PADDING = 2;
const MPG_CMD_DIAL_BYTE = 3;
const MPG_CMD_VELOCITY = 4;
const MPG_CMD_BYTE2 = 5;

// MPG DIAL Modes (CMD[3])
const MPG_DIAL_OFF = 0x00;
const MPG_DIAL_X_AXIS = 0x11;
const MPG_DIAL_Y_AXIS = 0x12;
const MPG_DIAL_Z_AXIS = 0x13;
const MPG_DIAL_A_AXIS = 0x18;
const MPG_DIAL_SPINDLE = 0x14;
const MPG_DIAL_FEED = 0x15;

var CMDS = [
    {name: "sleep", value: [0x00, 0x00], gcode: "None"},
    {name: "keyup", value: [0x00, 0x11], gcode: "\n"},
    {name: "arrow1", value: [0x01, 0x10], gcode: "g28.3x0y0z0a0\n"}, //Set Zero
    {name: "start_pause", value: [0x02, 0x13], gcode: "~ || !"},
    {name: "rewind", value: [0x03, 0x12], gcode: "None"},
    {name: "probez", value: [0x04, 0x15], gcode: "g28.3z0"},
    {name: "macro3", value: [0x05, 0x14]},
    {name: "half", value: [0x06, 0x17], gcode: "None"},
    {name: "zero", value: [0x07, 0x16], gcode: "g28.3"},
    {name: "safez", value: [0x08, 0x19], gcode: "g92"},
    {name: "arrow2", value: [0x09, 0x18], gcode: "g0x0y0z0a0\n"}, //Go to zero
    {name: "macro1", value: [0x0a, 0x1b]},
    {name: "macro2", value: [0x0b, 0x1a]},
    {name: "spindle", value: [0x0c, 0x1d], gcode: "None"},
    {name: "step++", value: [0x0d, 0x1c], gcode: "\n"},
    {name: "model", value: [0x0e, 0x1f]},
    {name: "macro6", value: [0x0f, 0x1e]},
    {name: "macro7", value: [0x10, 0x01]},
    {name: "stop", value: [0x16, 0x07], gcode: "!\n%\n"},
    {name: "reset", value: [0x17, 0x06], gcode: "None"},
];

var count = 15;
var isJogging = false;
var jogMode = "incremental"; //vs "continuous"
var units = "mm";
var stepDistance = 1;
var jogVelocityMultiplier = 1;
var velocityMin = 40; //mm/min
var calculatedVelocity = velocityMin;
var distanceTable = [10, 1, 0.1, 0.01];
var stepMulTable = [0x0A, 0x08, 0x03, 0x01]

function getDialSetting(dialByte) {
    switch (dialByte) {
        case(MPG_DIAL_OFF):
            return ("DIAL_OFF");
        case(MPG_DIAL_X_AXIS):
            return ("X");
        case(MPG_DIAL_Y_AXIS):
            return ("Y");
        case(MPG_DIAL_Z_AXIS):
            return ("Z");
        case(MPG_DIAL_A_AXIS):
            return ("A");
        case(MPG_DIAL_SPINDLE):
            return ("SPINDLE");
        case(MPG_DIAL_FEED):
            return ("FEED");
    }
}

function getStepDistance(){
    return distanceTable[stepDistance];
}

function setStepDistance() {
    stepDistance = stepDistance + 1;
    if (stepDistance == 4) {
        stepDistance = 0;
    }
}

//Continuous is the machine will continue to jog as long as there are event dial events coming in.
function doJogContinuous(dialSetting, cmd) {
    //build our jog command
    var velocity = cmd.value[1];
    //We need to figure out if this is a negative move or a positive move
    if (velocity > 0xaa) {
        sign = "-";
        velocity = 255 - velocity; // When rotating counter clockwise the velocity
        //Comes in as 0xfe for 1 which we will subtract from 0xff to get a sane number
    } else {
        sign = ""
    }
    tmpCalc = (velocity * 10) * velocityMin;
    if(tmpCalc > calculatedVelocity){
        calculatedVelocity = tmpCalc; //If we are moving faster than previously we will increase our speed.
    }
    console.log("SANE VELOCITY: " + velocity);
    cmd.gcode = "G91\nG1F" + calculatedVelocity + dialSetting + sign + count + "\n";
    return (cmd);
}

//Incremental Will only single step then stop and wait for another click of the jog dial.
function doJogIncremental(dialSetting, cmd) {
    var sign = 1;
    //build our jog command
    //We need to figure out if this is a negative move or a positive move
    if (cmd.value[1] > 0xaa) {
        sign = -1;
    }
    var feed = 3000;
    jog({dir: dialSetting, dist: sign * getStepDistance(), feed: feed});
}

function parseCommand(data) {
    switch (mpgType) {
        case 'HB03':
        case 'HB04':
            for (var i = 0; i < CMDS.length; i++) {
                if (data[MPG_CMD_BYTE1] == CMDS[i].value[0]) { //&& data[MPG_CMD_BYTE2] == CMDS[i].value[1]) {

                    if (data[MPG_CMD_VELOCITY] != 0x00) {
                        //We got a velocity, Now this is a JOG command vs a Keyup command.
                        var dist = 1;
                        if (data[MPG_CMD_VELOCITY] > 0xaa) {
                            dist = -1;
                        }
                        var dialSetting = getDialSetting(data[MPG_CMD_DIAL_BYTE]);
                        switch(dialSetting) {
                            case "DIAL_OFF":
                                break;
                            case "SPINDLE":
                                return ({name: "spindleOverride", value: dist});
                                break;
                            case "FEED":
                                return ({name: "feedOverride", value: dist});
                                break;
                            default:
                                return ({name: "jog", value: [0x00, data[MPG_CMD_VELOCITY], 0x9a], gcode: "G1F100"})
                                break;
                        }
                    }
                    return (CMDS[i]);
                }
            }
            break;
    }
    return null;
}

function parseMPGPacket(data) {
    switch (mpgType) {
    case 'HB03':
    case 'HB04':
        if (data[MPG_CMD_START_BYTE] == 0x04) { //0x04 is a constant for this device as the first byte
            var dialSetting = getDialSetting(data[MPG_CMD_DIAL_BYTE]);
            var tmpCmd = parseCommand(data);
            //writeLog(tmpCmd, 3);

            if (tmpCmd) {
                console.log("DIAL: " + dialSetting + " Command: " + tmpCmd.name, " Gcode: " + tmpCmd.gcode);

                switch (tmpCmd.name) {
                    case("rewind"):
                        io.sockets.emit('mpg', {key: 'rewind'});
                        break;
                    
                    case("probez"):
                        io.sockets.emit('mpg', {key: 'probez'});
                        probe({direction: 'z', probeOffset: 0});
                        break;
                        
                    case("spindle"):
                        io.sockets.emit('mpg', {key: 'spindle'});
                        laserTest({power: 1, duration: 0});
                        break;
                        
                    case("safez"):
                        io.sockets.emit('mpg', {key: 'safez'});
                        console.log("safez");
                        break;
                        
                    case("stop"):
                        io.sockets.emit('mpg', {key: 'stop'});
                        stopMachine();
                        break;

                    case("keyup"):
                        //If we were jogging we are in incremental mode
                        //We need to exit this mode now that we are done jogging.
                        if (isJogging) {
                            isJogging = false;

                            //What this does is if you are in continuous mode you will move until
                            //you stop twisting the dial.  This will then issue a feedhold flush command.
                            if (jogMode == "continuous") {
                                sendStopFlush();
                                calculatedVelocity = velocityMin;
                            }

                            machineSend("G90\n");
                            console.log("::-----Exiting Jog Mode------::");
                        }
                        break;

                    case("jog"):
                        console.log("::-----Entering Jog Mode------::");
                        isJogging = true;
                        if (jogMode == "incremental") {
                            doJogIncremental(dialSetting, tmpCmd);
                        } else {
                            tmpCmd = doJogContinuous(dialSetting, tmpCmd);
                        }
                        break;

                    case("feedOverride"):
                        feedOv(tmpCmd.value);
                        break;

                    case("spindleOverride"):
                        spindleOv(tmpCmd.value);
                        break;

                    case("start_pause"):
                        io.sockets.emit('mpg', {key: 'start_pause'});
                        if (paused) {
                            console.log("Sending Resume");
                            machineSend('~');
                        } else {
                            machineSend('!');
                            console.log("Sending Feedhold/Pause");
                        }
                        break;

                    case("half"):
                        io.sockets.emit('mpg', {key: 'half'});
                        console.log("Half");
                        break;

                    case("zero"):
                        switch(dialSetting) {
                            case "DIAL_OFF":
                                break;
                            case "SPINDLE":
                                spindleOv(0);                            
                                break;
                            case "FEED":
                                feedOv(0);                            
                                break;
                            default:
                                setZero(dialSetting.toLowerCase());
                                break;
                        }
                        break;

                    case("arrow1"):
                        io.sockets.emit('mpg', {key: 'arrow1'});
                        setZero('all');
                        break;
                        
                    case("arrow2"): //Arrow2 is, at least for now go to zero on all axis
                        io.sockets.emit('mpg', {key: 'arrow2'});
                        gotoZero('all');
                        break;

                    case("step++"):
                        io.sockets.emit('mpg', {key: 'stepsize'});
                        setStepDistance();
                        var stepSize = getStepDistance();
                        console.log("Changing Step Rate for Incremental Mode to " + stepSize);
                        break;

                    case("model"):
                        console.log("-----Changing Jog Modes----");
                        if (jogMode == "incremental") {
                            jogMode = "continuous";
                        } else {
                            jogMode = "incremental";
                        }
                        console.log("MODE: " + jogMode);
                        break;

                    case("sleep"):
                        console.log("MPG goes sleep");
                        break;

                    case('reset'):
                        io.sockets.emit('mpg', {key: 'reset'});
                        resetMachine();
                        break;
                        
                    case("macro1"):
                        io.sockets.emit('mpg', {key: 'macro1'});
                        console.log("Macro1");
                        runMarco(1);
                        break;
                    
                    case("macro2"):
                        io.sockets.emit('mpg', {key: 'macro2'});
                        console.log("Macro2");
                        runMarco(2);
                        break;
                        
                    case("macro3"):
                        io.sockets.emit('mpg', {key: 'macro3'});
                        console.log("Macro3");
                        runMarco(3);
                        break;

                    case("macro6"):
                        io.sockets.emit('mpg', {key: 'macro6'});
                        console.log("Macro6");
                        runMarco(6);
                        break;
                        
                    case("macro7"):
                        io.sockets.emit('mpg', {key: 'macro7'});
                        console.log("Macro7");
                        runMarco(7);
                        break;

                    default:
                        console.log("Un-Caught Case: " + tmpCmd.name, tmpCmd.value);
                        break;
                }

            } else {
                console.log("DIAL: " + dialSetting + " Command Code Unknown: ", data);
            }
        }
        break;
    }
}

var hb04_write_data = {
    /* header of our packet */
    magic1 : 0xFE,      // 8 bit
    magic2 : 0xFD,      // 8 bit
    day : 0x0C,         // 8 bit
    /* work pos */
    x_wc_int : 0,       // 16 bit
    x_wc_frac : 0,      // 16 bit
    y_wc_int : 0,       // 16 bit
    y_wc_frac : 0,      // 16 bit
    z_wc_int : 0,       // 16 bit
    z_wc_frac : 0,      // 16 bit
    a_wc_int : 0,       // 16 bit
    a_wc_frac : 0,      // 16 bit
    /* machine pos */
    x_mc_int : 0,       // 16 bit
    x_mc_frac : 0,      // 16 bit
    y_mc_int : 0,       // 16 bit
    y_mc_frac : 0,      // 16 bit
    z_mc_int : 0,       // 16 bit
    z_mc_frac : 0,      // 16 bit
    a_mc_int : 0,       // 16 bit
    a_mc_frac : 0,      // 16 bit
    /* speed */
    feedrate_ovr : 100, // 16 bit
    sspeed_ovr : 100,   // 16 bit
    feedrate : 100,     // 16 bit
    sspeed : 100,       // 16 bit
    step_mul : 0x01,    // 8 bit
    state : 0x01        // 8 bit
};

function setMpgWPos(pos) {
    switch (mpgType) {
        case 'HB03':
        case 'HB04':
            hb04_write_data.step_mul = stepMulTable[stepDistance];

            hb04_write_data.x_wc_int = parseInt(Math.abs(pos.x));
            var x_wc_frac = parseInt((Math.abs(pos.x) - hb04_write_data.x_wc_int) * 10000);
            if (pos.x < 0) x_wc_frac = x_wc_frac | 0x8000;
            hb04_write_data.x_wc_frac = x_wc_frac;

            hb04_write_data.y_wc_int = parseInt(Math.abs(pos.y));
            var y_wc_frac = parseInt((Math.abs(pos.y) - hb04_write_data.y_wc_int) * 10000);
            if (pos.y < 0) y_wc_frac = y_wc_frac | 0x8000;
            hb04_write_data.y_wc_frac = y_wc_frac;

            hb04_write_data.z_wc_int = parseInt(Math.abs(pos.z));
            var z_wc_frac = parseInt((Math.abs(pos.z) - hb04_write_data.z_wc_int) * 10000);
            if (pos.z < 0) z_wc_frac = z_wc_frac | 0x8000;
            hb04_write_data.z_wc_frac = z_wc_frac;

            hb04_write_data.feedrate_int = parseInt(Math.abs(feedOverride));
            var feedrate = parseInt((Math.abs(feedOverride) - hb04_write_data.feedrate_int) * 10000);
            if (feedOverride < 0) feedrate = feedrate | 0x8000;
            hb04_write_data.feedrate_ovr = feedrate;

            hb04_write_data.spindle_int = parseInt(Math.abs(spindleOverride));
            var spindle = parseInt((Math.abs(spindleOverride) - hb04_write_data.spindle_int) * 10000);
            if (spindleOverride < 0) spindle = spindle | 0x8000;
            hb04_write_data.sspeed_ovr = spindle;

            writeMPG(hb04_write_data);
            break;
    }
}

function setMpgMPos(pos) {
    switch (mpgType) {
        case 'HB03':
        case 'HB04':
            hb04_write_data.step_mul = stepMulTable[stepDistance];

            hb04_write_data.x_mc_int = parseInt(Math.abs(pos.x));
            var x_mc_frac = parseInt((Math.abs(pos.x) - hb04_write_data.x_mc_int) * 10000);
            if (pos.x < 0) x_mc_frac = x_mc_frac | 0x8000;
            hb04_write_data.x_mc_frac = x_mc_frac;

            hb04_write_data.y_mc_int = parseInt(Math.abs(pos.y));
            var y_mc_frac = parseInt((Math.abs(pos.y) - hb04_write_data.y_mc_int) * 10000);
            if (pos.y < 0) y_mc_frac = y_mc_frac | 0x8000;
            hb04_write_data.y_mc_frac = y_mc_frac;

            hb04_write_data.z_mc_int = parseInt(Math.abs(pos.z));
            var z_mc_frac = parseInt((Math.abs(pos.z) - hb04_write_data.z_mc_int) * 10000);
            if (pos.z < 0) z_mc_frac = z_mc_frac | 0x8000;
            hb04_write_data.z_mc_frac = z_mc_frac;

            writeMPG(hb04_write_data);
            break;
    }
}

function setMpgWOffset(pos) {
    switch (mpgType) {
        case 'HB03':
        case 'HB04':
            break;
    }
}

function writeMPG(data) {
    writeLog('WX:' + data.x_wc_int + '.' + data.x_wc_frac + ', WY:' + data.y_wc_int + '.' + data.y_wc_frac + ', WZ:' + data.z_wc_int + '.' + data.z_wc_frac, 3);
    //console.log(JSON.stringify(data));
    var part1 = [6, data.magic1, data.magic2, data.day, data.x_wc_int & 0xFF, data.x_wc_int >> 8, data.x_wc_frac & 0xFF, data.x_wc_frac >> 8];
    writeLog(JSON.stringify(part1), 3);
    var part2 = [6, data.y_wc_int & 0xFF, data.y_wc_int >> 8, data.y_wc_frac & 0xFF, data.y_wc_frac >> 8, data.z_wc_int & 0xFF, data.z_wc_int >> 8, data.z_wc_frac & 0xFF];
    writeLog(JSON.stringify(part2), 3);
    var part3 = [6, data.z_wc_frac >> 8, data.x_mc_int & 0xFF, data.x_mc_int >> 8, data.x_mc_frac & 0xFF, data.x_mc_frac >> 8, data.y_mc_int & 0xFF, data.y_mc_int >> 8];
    writeLog(JSON.stringify(part3), 3);
    var part4 = [6, data.y_mc_frac & 0xFF, data.y_mc_frac >> 8, data.z_mc_int & 0xFF, data.z_mc_int >> 8, data.z_mc_frac & 0xFF, data.z_mc_frac >> 8, data.feedrate_ovr & 0xFF];
    writeLog(JSON.stringify(part4), 3);
    var part5 = [6, data.feedrate_ovr >> 8, data.sspeed_ovr & 0xFF, data.sspeed_ovr >> 8, data.feedrate & 0xFF, data.feedrate >> 8, data.sspeed & 0xFF, data.sspeed >> 8];
    writeLog(JSON.stringify(part5), 3);
    var part6 = [6, data.step_mul, 0, 0, 0, 0, 0, 0]; //data.state
    writeLog(JSON.stringify(part6), 3);
    
    if (mpgWrite) {
        mpgWrite.sendFeatureReport(part1);
        mpgWrite.sendFeatureReport(part2);  
        mpgWrite.sendFeatureReport(part3);  
        mpgWrite.sendFeatureReport(part4);  
        mpgWrite.sendFeatureReport(part5);  
        mpgWrite.sendFeatureReport(part6);
    }
}
//========================
// MPG implementation end
//========================


function isElectron() {
    if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
        return true;
    }
    if (typeof process !== 'undefined' && process.versions && !!process.versions.electron) {
        return true;
    }
    return false;
}

function writeLog(line, verb) {
    if (verb<=config.verboseLevel) {
        console.log(line);
    }
    if (config.logLevel>0 && verb<=config.logLevel) {
        if (!logFile) {
            if (isElectron() && os.platform == 'darwin') {
                //io.sockets.emit('data', 'Running on Darwin (macOS)');
                logFile = fs.createWriteStream(path.join(electronApp.getPath('userData'),'logfile.txt'));
            } else {
                logFile = fs.createWriteStream('./logfile.txt');
            }
            logFile.on('error', function(e) { console.error(e); });
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

//Handles performing any pre/post/abort actions
//Action = command line specific for OS
function doJobAction(action) {

    //NAB - Added to support action to run after job completes
    if (typeof action === 'string' && action.length > 0) {
        try {
            exec(action);
        } catch (e) {
            //Unable to start jobAfter command
            writeLog(chalk.red('ERROR: ') + chalk.blue('Error on job command: ' + e.message + ' for action: ' + action), 2);
        }

    }

}

}

if (require.main === module) {
    exports.LWCommServer(config);
}
