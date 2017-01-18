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
var app = require('http').createServer(handler);
var io = websockets.listen(app);
//var telnet = require('telnet-client');
var WebSocket = require('ws');
var net = require('net');
var fs = require('fs');
var nstatic = require('node-static');
var url = require('url');
var util = require('util');
var chalk = require('chalk');
var request = require('request'); // proxy for remote webcams

//var EventEmitter = require('events').EventEmitter;
//var qs = require('querystring');
//var http = require('http');

var logFile;
var connectionType, connections = [];
var gcodeQueue = [];
var portType; 
var port, isConnected, connectedTo;
var machineSocket, connectedIp;
var telnetSocket, telnetBuffer, telnetConnected, telnetIP; 
var espSocket, espBuffer, espConnected, espIP;

var statusLoop, queueCounter;
var lastSent = '', paused = false, blocked = false;

var firmware, fVersion, fDate;
var feedOverride = 100;
var spindleOverride = 100;
var laserTestOn = false;

var GRBL_RX_BUFFER_SIZE = 128; // 128 characters
var grblBufferSize = [];

var SMOOTHIE_RX_BUFFER_SIZE = 64;  // max. length of one command line
var smoothie_buffer = true;

var TINYG_RX_BUFFER_SIZE = 4;       // max. lines of gcode to send before wait for ok
var tinygBufferSize = TINYG_RX_BUFFER_SIZE; // init space left
var jsObject;


require('dns').lookup(require('os').hostname(), function (err, add, fam) {
    writeLog(chalk.green(' '));
    writeLog(chalk.green('***************************************************************'));
    writeLog(chalk.white('                 ---- LaserWeb Comm Server ----                '));
    writeLog(chalk.green('***************************************************************'));
    writeLog(chalk.white('  Use ') + chalk.yellow(' http://' + add + ':' + config.webPort + ' to connect this server.'));
    writeLog(chalk.green('***************************************************************'));
    writeLog(chalk.green(' '));
    writeLog(chalk.green(' '));
    writeLog(chalk.red('* Updates: '));
    writeLog(chalk.green('  Remember to check the commit log on'));
    writeLog(chalk.yellow('  https://github.com/LaserWeb/lw.comm-server/commits/master'));
    writeLog(chalk.green('  regularly, to know about updates and fixes, and then when ready'));
    writeLog(chalk.green('  update accordingly by running ') + chalk.cyan('git pull'));
    writeLog(chalk.green(' '));
    writeLog(chalk.red('* Support: '));
    writeLog(chalk.green('  If you need help / support, come over to '));
    writeLog(chalk.green('  ') + chalk.yellow('https://plus.google.com/communities/115879488566665599508'));
    writeLog(chalk.green('***************************************************************'));
    writeLog(chalk.green(' '));
});


// Init webserver
app.listen(config.webPort);
var webServer = new nstatic.Server('./app');

function handler(req, res) {
    var queryData = url.parse(req.url, true).query;
    if (queryData.url) {
        if (queryData.url !== '') {
            request({
                url: queryData.url, // proxy for remote webcams
                callback: (err, res, body) => {
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
}


// WebSocket connection from frontend
io.sockets.on('connection', function (appSocket) {

    // save new connection
    connections.push(appSocket);

    // send available ports
    serialport.list(function (err, ports) {
        appSocket.emit('ports', ports);
    });

    appSocket.on('firstLoad', function (data) {
        appSocket.emit('config', config);
        if (isConnected) {
            if (port) {
                appSocket.emit('activePorts', port.path + ',' + port.options.baudRate);
                appSocket.emit('connectStatus', 'opened:' + port.path);
            } else {
                appSocket.emit('connectStatus', 'opened:' + connectedTo);
            }
        }
    });

    appSocket.on('getFirmware', function (data) { // Deliver Firmware to Web-Client
        appSocket.emit("firmware", firmware + ',' + fVersion);
    });

    appSocket.on('refreshPorts', function (data) { // Refresh serial port list
        console.log(chalk.yellow('WARN:'), chalk.blue('Requesting Ports Refresh '));
        serialport.list(function (err, ports) {
            appSocket.emit("ports", ports);
        });
    });

    appSocket.on('connectTo', function (data) { // If a user picks a port to connect to, open a Node SerialPort Instance to it
        data = data.split(',');
        writeLog(chalk.yellow('WARN:') + chalk.blue('Connecting to ' + data));
        connectionType = data[0].toLowerCase();
        if (!isConnected) {
            switch (connectionType) {
                case 'usb':
                    port = new SerialPort(data[1], {
                        parser: serialport.parsers.readline('\n'),
                        baudrate: parseInt(data[2])
                    });
                    io.sockets.emit('connectStatus', 'opening:' + port.path);

                    // Serial port events -----------------------------------------------
                    port.on('open', function () {
                        io.sockets.emit('activePorts', port.path + ',' + port.options.baudRate);
                        io.sockets.emit('connectStatus', 'opened:' + port.path);
                        setTimeout(function() { //wait for controller to be ready
                            if (!firmware) { // Grbl should be allready retected
                                port.write("version\n"); // Check if it's Smoothieware?
                                setTimeout(function() {  // Wait for Smoothie to answer
                                    if (!firmware) {     // If still not set
                                        port.write("$fb\n"); // Check if it's TinyG
                                    }
                                }, 500);
                            }
                        }, 500);
                        // port.write("M115\n");    // Lets check if its Marlin?

                        writeLog(chalk.yellow('WARN:') + 'Connected to ' + port.path + ' at ' + port.options.baudRate);
                        isConnected = true;
                        connectedTo = port.path;

                        // Start interval for qCount messages to socket clients
                        queueCounter = setInterval(function () {
                            io.sockets.emit('qCount', gcodeQueue.length);
                        }, 500);
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
                        writeLog(chalk.yellow('WARN:') + chalk.blue('Port closed'));
                    });

                    port.on('error', function (err) { // open errors will be emitted as an error event
                        writeLog(chalk.yellow('ERROR:') + chalk.blue(err.message));
                        io.sockets.emit("data", err.message);
                    });

                    port.on('data', function (data) {
                        writeLog('Recv: ' + data);
                        if (data.indexOf('Grbl') === 0) { // Check if it's Grbl
                            firmware = 'grbl';
                            fVersion = data.substr(5, 4); // get version
                            writeLog('GRBL detected (' + fVersion + ')');
                            // Start intervall for status queries
                            statusLoop = setInterval(function () {
                                if (isConnected) {
                                    machineSend('?');
                                }
                            }, 250);
                        }
                        if (data.indexOf('LPC176') >= 0) { // LPC1768 or LPC1769 should be Smoothie
                            firmware = 'smoothie';
                            SMOOTHIE_RX_BUFFER_SIZE = 64;  // max. length of one command line
                            var startPos = data.search(/version:/i) + 9;
                            fVersion = data.substr(startPos).split(/,/, 1);
                            startPos = data.search(/Build date:/i) + 12;
                            fDate = new Date(data.substr(startPos).split(/,/, 1));
                            var dateString = fDate.toDateString();
                            writeLog('Smoothieware detected (' + fVersion + ', ' + dateString + ')');
                            // Start intervall for status queries
                            statusLoop = setInterval(function () {
                                if (isConnected) {
                                    machineSend('?');
                                }
                            }, 250);
                        }
                        if (data.indexOf('ok') === 0) { // Got an OK so we are clear to send
                            blocked = false;
                            if (firmware === 'grbl') {
                                grblBufferSize.shift();
                            }
                            send1Q();
                        }
                        if (data.indexOf('error') === 0) {
                            if (firmware === 'grbl') {
                                grblBufferSize.shift();
                            }
                        }
                        if (data.indexOf('{') === 0) { // JSON response (probably TinyG)
                            jsObject = JSON.parse(data);
                            if (jsObject.hasOwnProperty('r')) {
                                var footer = jsObject.f || (jsObject.r && jsObject.r.f);
                                if (footer !== undefined) {
                                    if (footer[1] == 108) {
                                        writeLog(
                                            "Response" +
                                            util.format("TinyG reported an syntax error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]) +
                                            jsObject
                                        );
                                    } else if (footer[1] == 20) {
                                        writeLog(
                                            "Response" +
                                            util.format("TinyG reported an internal error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]) +
                                            jsObject
                                        );
                                    } else if (footer[1] == 202) {
                                        writeLog(
                                            "Response" +
                                            util.format("TinyG reported an TOO SHORT MOVE on line %d", jsObject.r.n) +
                                            jsObject
                                        );
                                    } else if (footer[1] == 204) {
                                        writeLog(
                                            "InAlarm" +
                                            util.format("TinyG reported COMMAND REJECTED BY ALARM '%s'", part) +
                                            jsObject
                                        );
                                    } else if (footer[1] != 0) {
                                        writeLog(
                                            "Response" +
                                            util.format("TinyG reported an error reading '%s': %d (based on %d bytes read)", JSON.stringify(jsObject.r), footer[1], footer[2]) +
                                            jsObject
                                        );
                                    }
                                }

                                writeLog('response' + jsObject.r + footer);

                                jsObject = jsObject.r;

                                tinygBufferSize++;
                                blocked = false;
                                send1Q();
                            }

                            if (jsObject.hasOwnProperty('er')) {
                                writeLog('errorReport' + jsObject.er);
                            } else if (jsObject.hasOwnProperty('sr')) {
                                writeLog('statusChanged' + jsObject.sr);
                            } else if (jsObject.hasOwnProperty('gc')) {
                                writeLog('gcodeReceived' + jsObject.gc);
                            }

                            if (jsObject.hasOwnProperty('rx')) {
                                writeLog('rxReceived' + jsObject.rx);
                            }
                            if (jsObject.hasOwnProperty('fb')) { // TinyG detected
                                firmware = 'tinyg';
                                fVersion = jsObject.fb;
                                writeLog('TinyG detected (' + fVersion + ')');
                                // Start intervall for status queries
                                statusLoop = setInterval(function () {
                                    if (isConnected) {
                                        machineSend('{"sr":null}');
                                    }
                                }, 250);
                            }
                        }

                        io.sockets.emit('data', data);
                    });
                    break;
                
                case 'telnet':
                    connectedIp = data[1];
                    machineSocket = net.connect(23, connectedIp); 
                    io.sockets.emit('connectStatus', 'opening:' + connectedIp);

                    // Telnet connection events -----------------------------------------------
                    machineSocket.on('connect', function (prompt) {
                        io.sockets.emit('connectStatus', 'opened:' + connectedIp);
                        writeLog(chalk.yellow('WARN: ') + chalk.blue('Telnet connected to ' + connectedIp));
                        isConnected = true;
                        connectedTo = connectedIp;
                        machineSocket.write('version\n');

                        // Start intervall for status queries
                        statusLoop = setInterval(function () {
                            if (isConnected) {
                                //machineSocket.write('get pos\n');
                            } else {
                                clearInterval(statusLoop);
                                writeLog(chalk.yellow('WARN: ') + 'Unable to send gcode (not connected to Telnet): ' + e);
                            }
                        }, 250);

                        // Start interval for qCount messages to appSocket clients
                        queueCounter = setInterval(function () {
                            io.sockets.emit('qCount', gcodeQueue.length);
                        }, 500);
                    });

                    machineSocket.on('timeout', function () {
                        writeLog(chalk.yellow('WARN: ') + chalk.blue('Telnet timeout!'));
                        machineSocket.end();
                    });

                    machineSocket.on('close', function () {
                        isConnected = false;
                        connectedTo = false;
                        paused = false;
                        blocked = false;
                        io.sockets.emit("connectStatus", 'Connect');
                        writeLog(chalk.yellow('WARN:') + chalk.blue('Telnet connection closed'));
                    });         

                    machineSocket.on('error', function (e) {
                        io.sockets.emit("error", e.message);
                        console.log(chalk.red('ERROR:'), 'Telnet error: ' + e.message);
                    });
                    
                    machineSocket.on('data', function(data) {
                        //var bytes = new Uint8Array(data);
                        for (var i = 0; i < data.length; i++) {
                            if (data[i] != 0x0d) {
                                telnetBuffer += String.fromCharCode(data[i]);
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
                        var response = '';
                        while (responseArray.length > 0) {
                            response = responseArray.shift();
                            //console.log('Telnet:', response);
                            if (response.indexOf('LPC176') >= 0) { // LPC1768 or LPC1769 should be Smoothie
                                console.log('Telnet:', response);
                                firmware = 'smoothie';
                                var startPos = response.search(/Version:/i) + 9;
                                fVersion = response.substr(startPos).split(/,/, 1);
                                SMOOTHIE_RX_BUFFER_SIZE = 64;  // max. length of one command line
                                console.log('Smoothieware detected (' + fVersion + ')');
                                io.sockets.emit('data', response);
                            }
                            if (response.indexOf('ok') === 0) { // Got an OK so we are clear to send
                                console.log('Telnet:', response);
                                blocked = false;
                                if (firmware === 'grbl') {
                                    grblBufferSize.shift();
                                }
                                send1Q();
                                io.sockets.emit('data', response);
                            }
                            if (response.indexOf('error') === 0) {
                                console.log('Telnet:', response);
                                if (firmware === 'grbl') {
                                    grblBufferSize.shift();
                                }
                                io.sockets.emit('data', response);
                            }
                            if (response.indexOf('WCS:') >= 0) {
                                //console.log('Telnet:', response);
                                // IN: "last C: X:0.0000 Y:-0.0000 Z:0.0000 realtime WCS: X:0.0000 Y:0.0045 Z:0.0000 MCS: X:44.2000 Y:76.5125 Z:0.0000 APOS: X:44.2000 Y:76.5125 Z:0.0000 MP: X:44.2000 Y:76.5080 Z:0.0000 CMP: X:44.2000 Y:76.5080 Z:0.0000"
                                // OUT: "<Run,MPos:49.5756,279.7644,-15.0000,WPos:0.0000,0.0000,0.0000>"
                                var startPos = response.search(/wcs: /i) + 5;
                                var wpos;
                                if (startPos > 5) {
                                    wpos = response.substr(startPos).split(/:| /, 6);
                                }
                                if (Array.isArray(wpos)) {
                                    var wxpos = parseFloat(wpos[1]).toFixed(2);
                                    var wypos = parseFloat(wpos[3]).toFixed(2);
                                    var wzpos = parseFloat(wpos[5]).toFixed(2);
                                    var wpos = wxpos + ',' + wypos + ',' + wzpos;
                                    console.log('Telnet:', 'WPos:' + wpos);
                                    io.sockets.emit('wpos', wpos);
                                }
                            }
                            if (response.indexOf('MCS:') >= 0) {
                                //console.log('Telnet:', response);
                                // IN: "last C: X:0.0000 Y:-0.0000 Z:0.0000 realtime WCS: X:0.0000 Y:0.0045 Z:0.0000 MCS: X:44.2000 Y:76.5125 Z:0.0000 APOS: X:44.2000 Y:76.5125 Z:0.0000 MP: X:44.2000 Y:76.5080 Z:0.0000 CMP: X:44.2000 Y:76.5080 Z:0.0000"
                                // OUT: "<Run,MPos:49.5756,279.7644,-15.0000,WPos:0.0000,0.0000,0.0000>"
                                var startPos = response.search(/mcs: /i) + 5;
                                var mpos;
                                if (startPos > 5) {
                                    mpos = response.substr(startPos).split(/:| /, 6);
                                }
                                if (Array.isArray(wpos)) {
                                    var mxpos = parseFloat(mpos[1]).toFixed(2);
                                    var mypos = parseFloat(mpos[3]).toFixed(2);
                                    var mzpos = parseFloat(mpos[5]).toFixed(2);
                                    var mpos = mxpos + ',' + mypos + ',' + mzpos;
                                    console.log('Telnet:', 'MPos:' + mpos);
                                    io.sockets.emit('mpos', mpos);
                                }
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
                        io.sockets.emit('connectStatus', 'opened:' + connectedIp);
                        writeLog(chalk.yellow('WARN: ') + chalk.blue('ESP connected @ ' + connectedIP));
                        isConnected = true;
                        connectedTo = connectedIp;
                        machineSocket.send(String.fromCharCode(0x18));
                        
                        // Start intervall for status queries
                        statusLoop = setInterval(function () {
                            if (isConnected) {
                                machineSocket.send('?');
                                //writeLog('ESP sent: ' + '?');
                            } else {
                                clearInterval(statusLoop);
                                writeLog(chalk.yellow('WARN: ') + 'Unable to send gcode (not connected to ESP): ' + e);
                            }
                        }, 250);

                        // Start interval for qCount messages to appSocket clients
                        queueCounter = setInterval(function () {
                            io.sockets.emit('qCount', gcodeQueue.length);
                        }, 500);
                    });

                    machineSocket.on('close', function (e) {
                        isConnected = false;
                        connectedTo = false;
                        paused = false;
                        blocked = false;
                        io.sockets.emit('connectStatus', 'Connect');
                        console.log(chalk.yellow('WARN: '), chalk.blue('ESP connection closed'));
                    });

                    machineSocket.on('error', function (e) {
                        io.sockets.emit('error', e.message);
                        console.log(chalk.red('ERROR: '), 'ESP error: ' + e.message);
                    });

                    machineSocket.on('message', function (e) {
                        espBuffer += e;
                        var split = espBuffer.split('\n');
                        espBuffer = split.pop();
                        for (var i = 0; i < split.length; i++) {
                            var response = split[i];
                            if (response.length > 0) {
                                console.log('ESP:', response);
                                if (response.indexOf('Grbl') === 0) { // Check if it's Grbl
                                    firmware = 'grbl';
                                    fVersion = response.substr(5, 4); // get version
                                    console.log('GRBL detected (' + fVersion + ')');
                                }
                                if (response.indexOf('LPC176') >= 0) { // LPC1768 or LPC1769 should be Smoothie
                                    firmware = 'smoothie';
                                    SMOOTHIE_RX_BUFFER_SIZE = 64;  // max. length of one command line
                                    var startPos = response.search(/Version:/i) + 9;
                                    fVersion = response.substr(startPos).split(/,/, 1);
                                    console.log('Smoothieware detected (' + fVersion + ')');
                                }
                                if (response.indexOf('ok') === 0) { // Got an OK so we are clear to send
                                    blocked = false;
                                    if (firmware === 'grbl') {
                                        grblBufferSize.shift();
                                    }
                                    send1Q();
                                }
                                if (response.indexOf('error') === 0) {
                                    if (firmware === 'grbl') {
                                        grblBufferSize.shift();
                                    }
                                }
                                io.sockets.emit('data', response);
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
        if (isConnected) {
            data = data.split('\n');
            for (var i = 0; i < data.length; i++) {
                var line = data[i].split(';'); // Remove everything after ; = comment
                var tosend = line[0];
                if (tosend.length > 0) {
                    addQ(tosend);
                }
            }
            if (i > 0) {
                io.sockets.emit("running", gcodeQueue.length);
                send1Q();
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'));
        }
    });

    appSocket.on('runCommand', function (data) {
        if (isConnected) {
            data = data.split('\n');
            for (var i = 0; i < data.length; i++) {
                var line = data[i].split(';'); // Remove everything after ; = comment
                var tosend = line[0];
                if (tosend.length > 0) {
                    addQ(tosend);
                }
            }
            send1Q();
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'));
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
                        writeLog(chalk.red('Feed Override ' + data + '%'));
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
                    jumpQ('M220S' + feedOverride);
                    io.sockets.emit('feedOverride', feedOverride);
                    writeLog(chalk.red('Feed Override ' + feedOverride.toString() + '%'));
                    send1Q();
                    break;
                case 'tinyg':
                    break;
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'));
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
                        writeLog(chalk.red('Spindle (Laser) Override ' + data + '%'));
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
                    jumpQ('M221S' + spindleOverride);
                    io.sockets.emit('spindleOverride', spindleOverride);
                    writeLog(chalk.red('Spindle (Laser) Override ' + spindleOverride.toString() + '%'));
                    send1Q();
                    break;
                case 'tinyg':
                    break;
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'));
        }
    });

    appSocket.on('laserTest', function (data) { // Laser Test Fire
        if (isConnected) {
            data = data.split(',');
            var power = parseFloat(data[0]);
            var duration = parseInt(data[1]);
            writeLog('laserTest: ' + 'Power ' + power + ', Duration ' + duration);
            if (power > 0) {
                if (!laserTestOn) {
                    // laserTest is off
                    if (duration >= 0) {
                        switch (firmware) {
                            case 'grbl':
                                addQ('G1F1');
                                addQ('M3S' + power);
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
                                    addQ('M5\n');
                                    setTimeout(function() {
                                        laserTestOn = false;
                                        appSocket.emit('laserTest', 0);
                                    }, duration );
                                }
                                send1Q();
                                break;
                            case 'tinyg':
                                addQ('G1F1');
                                addQ('M3S' + power);
                                laserTestOn = true;
                                appSocket.emit('laserTest', power);
                                if (duration > 0) {
                                    addQ('G4 P' + duration / 1000);
                                    addQ('M5S0');
                                    laserTestOn = false;
                                    setTimeout(function() {
                                        laserTestOn = false;
                                        appSocket.emit('laserTest', 0);
                                    }, duration );
                                }
                                send1Q();
                                break;
                        }
                    }
                } else {
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
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'));
        }
    });

    appSocket.on('pause', function (data) {
        if (isConnected) {
            paused = true;
            writeLog(chalk.red('PAUSE'));
            switch (firmware) {
                case 'grbl':
                    machineSend('!'); // Send hold command
                    if (fVersion === '1.1d') {
                        machineSend(String.fromCharCode(0x9E)); // Stop Spindle/Laser
                    }
                    break;
                case 'smoothie':
                    machineSend("M600"); // Laser will be turned off by smoothie (in default config!)
                    break;
                case 'tinyg':
                    machineSend('!'); // Send hold command
                    break;
            }
            io.sockets.emit("connectStatus", 'paused');
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'));
        }
    });

    appSocket.on('resume', function (data) {
        if (isConnected) {
            writeLog(chalk.red('RESUME'));
            io.sockets.emit("connectStatus", 'resumed');
            switch (firmware) {
                case 'grbl':
                    machineSend('~'); // Send resume command
                    break;
                case 'smoothie':
                    machineSend("M601");
                    break;
                case 'tinyg':
                    machineSend('~'); // Send resume command
                    break;
            }
            paused = false;
            send1Q(); // restart queue
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'));
        }
    });

    appSocket.on('stop', function (data) {
        if (isConnected) {
            paused = true;
            writeLog(chalk.red('STOP'));
            switch (firmware) {
                case 'grbl':
                    machineSend('!'); // hold
                    if (fVersion === '1.1d') {
                        machineSend(String.fromCharCode(0x9E)); // Stop Spindle/Laser
                    }
                    gcodeQueue.length = 0; // dump the queye
                    grblBufferSize.length = 0; // dump bufferSizes
                    blocked = false;
                    paused = false;
                    machineSend(String.fromCharCode(0x18)); // ctrl-x
                    break;
                case 'smoothie':
                    paused = true;
                    machineSend(String.fromCharCode(0x18)); // ctrl-x
                    gcodeQueue.length = 0; // dump the queye
                    grblBufferSize.length = 0; // dump bufferSizes
                    blocked = false;
                    paused = false;
                    break;
                case 'tinyg':
                    machineSend('!'); // hold
                    machineSend('%'); // dump TinyG queue
                    gcodeQueue.length = 0; // dump LW queue
                    grblBufferSize.length = 0; // dump bufferSizes
                    tinygBufferSize = TINYG_RX_BUFFER_SIZE;
                    blocked = false;
                    paused = false;
                    break;
            }
            laserTestOn = false;
            io.sockets.emit("stopped", 0);
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'));
        }
    });

    appSocket.on('clearAlarm', function (data) { // Laser Test Fire
        if (isConnected) {
            writeLog('Clearing Queue: Method ' + data);
            switch (data) {
                case '1':
                    writeLog('Clearing Lockout');
                    switch (firmware) {
                        case 'grbl':
                            machineSend("$X");
                            break;
                        case 'smoothie':
                            machineSend("$X");
                            break;
                        case 'tinyg':
                            machineSend('$X'); // resume
                            break;
                    }
                    writeLog('Resuming Queue Lockout');
                    break;
                case '2':
                    writeLog('Emptying Queue');
                    gcodeQueue.length = 0; // dump the queye
                    grblBufferSize.length = 0; // dump bufferSizes
                    writeLog('Clearing Lockout');
                    switch (firmware) {
                        case 'grbl':
                            machineSend("$X");
                            break;
                        case 'smoothie':
                            machineSend("$X"); //M999
                            break;
                        case 'tinyg':
                            machineSend('%'); // flush tinyg quere
                            tinygBufferSize = TINYG_RX_BUFFER_SIZE;
                            machineSend('~'); // resume
                            break;
                    }
                    break;
            }
        } else {
            io.sockets.emit("connectStatus", 'closed');
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'));
        }
    });

    
    appSocket.on('closePort', function (data) { // Close machine port and dump queue
        if (isConnected) {
            switch (connectionType) {
                case 'usb':
                    writeLog(chalk.yellow('WARN: ') + chalk.blue('Closing Port ' + port.path));
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
                    writeLog(chalk.yellow('WARN: ') + chalk.blue('Closing Telnet @ ' + connectedIp));
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
                    writeLog(chalk.yellow('WARN: ') + chalk.blue('Closing ESP @ ' + connectedIp));
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
            writeLog(chalk.red('ERROR: ') + chalk.blue('Machine connection not open!'));
        }
    });


    appSocket.on('getFirmware', function (data) { // Deliver Firmware to Web-Client
        appSocket.emit('firmware', firmware + '|' + fVersion + '|' + fDate);
    });

    appSocket.on('refreshPorts', function (data) { // Refresh serial port list
        writeLog(chalk.yellow('WARN:') + chalk.blue('Requesting Ports Refresh '));
        serialport.list(function (err, ports) {
            appSocket.emit('ports', ports);
        });
    });

    appSocket.on('areWeLive', function (data) { // Report active serial port to web-client
        if (isConnected) {
            appSocket.emit('activePorts', port.path + ',' + port.options.baudRate);
        }
    });

    appSocket.on('closeTelnet', function (data) { // Close socket connection to Smoothie
        if (isConnected) {
            writeLog(chalk.yellow('WARN: ') + chalk.blue('Closing Telnet @ ' + connectedIp));
            io.sockets.emit("connectStatus", 'closing:' + connectedIp);
            //machineSend(String.fromCharCode(0x18)); // ctrl-x
            gcodeQueue.length = 0; // dump the queye
            grblBufferSize.length = 0; // dump bufferSizes
            tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
            clearInterval(queueCounter);
            clearInterval(statusLoop);
            machineSocket.destroy();
        } else {
            io.sockets.emit("connectStatus", 'Connect');
            writeLog(chalk.yellow('WARN: ') + chalk.blue('Telnet connection already closed'));
        }
    });

    appSocket.on('closeEsp', function (data) { // Close socket connection to ESP
        if (isConnected) {
            writeLog(chalk.yellow('WARN: ') + chalk.blue('Closing ESP @ ' + connectedIp));
            io.sockets.emit("connectStatus", 'closing:' + connectedIp);
            //machineSend(String.fromCharCode(0x18)); // ctrl-x
            gcodeQueue.length = 0; // dump the queye
            grblBufferSize.length = 0; // dump bufferSizes
            tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
            clearInterval(queueCounter);
            clearInterval(statusLoop);
            machineSocket.close();
        } else {
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.yellow('WARN:') + chalk.blue('ESP connection already closed'));
        }
    });

    appSocket.on('disconnect', function () { // Deliver Firmware to Web-Client
        writeLog(chalk.yellow('App disconnectd!'));
    });

}); // End appSocket


// Queue
function addQ(gcode) {
    gcodeQueue.push(gcode);
}

function jumpQ(gcode) {
    gcodeQueue.unshift(gcode);
}

function grblBufferSpace() {
    var total = 0;
    for (var i = 0, n = grblBufferSize.length; i < n; ++i) {
        total += grblBufferSize[i];
    }
    return GRBL_RX_BUFFER_SIZE - total;
}

function machineSend(gcode) {
    switch (connectionType) {
        case 'usb':
            port.write(gcode + '\n');
            break;
        case 'telnet':
            machineSocket.write(gcode + '\n');
            break;
        case 'esp8266':
            machineSocket.send(gcode + '\n');
            break;
    }
}

function send1Q() {
    var gcode;
    var gcodeLen = 0;
    var spaceLeft = 0;
    if (isConnected) {
        switch (firmware) {
            case 'grbl':
                while (gcodeQueue.length > 0 && !blocked && !paused) {
                    // Optimise gcode by stripping spaces - saves a few bytes of serial bandwidth, and formatting commands vs gcode to upper and lowercase as needed
                    gcode = gcodeQueue.shift().replace(/\s+/g, '');
                    spaceLeft = grblBufferSpace();
                    gcodeLen = gcode.length;
                    //writeLog('BufferSpace: ' + spaceLeft + ' gcodeLen: ' + gcodeLen);
                    if (gcodeLen <= spaceLeft) {
                        grblBufferSize.push(gcodeLen);
                        machineSend(gcode);
                        lastSent = gcode;
                        writeLog('Sent: ' + gcode + ' Q: ' + gcodeQueue.length);
                    } else {
                        gcodeQueue.unshift(gcode);
                        blocked = true;
                    }
                }
                break;
            case 'smoothie':
                if (smoothie_buffer) {
                    var gcodeLine = '';
                    var lastMode = '';
                    spaceLeft = SMOOTHIE_RX_BUFFER_SIZE - gcodeLine.length;
                    while (gcodeQueue.length > 0 && spaceLeft > 0 && !blocked && !paused) {
                        gcode = gcodeQueue.shift();
                        if (gcode.indexOf('fire ') === -1) { // && gcode.indexOf('G4') === -1) {
                            gcode = gcode.replace(/\s+/g, '');
                        }
                        if (gcode.length < spaceLeft) {
                            // Add gcode to send buffer
                            gcodeLine += gcode;
                            spaceLeft = SMOOTHIE_RX_BUFFER_SIZE - gcodeLine.length;
                        } else {
                            // Not enough space left in send buffer 
                            // -> push gcode back to queue and leave while loop
                            gcodeQueue.unshift(gcode);
                            blocked = true;
                        }
                    }
                    if (gcodeLine.length > 0) {
                        // Send the buffer
                        blocked = true;
                        machineSend(gcodeLine);
                        lastSent = gcodeLine;
                        writeLog('Sent: ' + gcodeLine + ' Q: ' + gcodeQueue.length);
                        gcodeLine = '';
                        lastMode = '';
                    }
                } else {
                    if (gcodeQueue.length > 0 && !blocked && !paused) {
                        gcode = gcodeQueue.shift();
                        if (gcode.indexOf('fire ') === -1) {
                            gcode = gcode.replace(/\s+/g, '');
                        }
                        blocked = true;
                        machineSend(gcode);
                        lastSent = gcode;
                        writeLog('Sent: ' + gcode + ' Q: ' + gcodeQueue.length);
                    }
                }
                break;
            case 'tinyg':
                while (tinygBufferSize > 0 && gcodeQueue.length > 0 && !blocked && !paused) {
                    gcode = gcodeQueue.shift();
                    gcode = gcode.replace(/\s+/g, '');
                    writeLog('Sent: ' + gcode + ' Q: ' + gcodeQueue.length);
                    lastSent = gcode;
                    machineSend(gcode);
                    tinygBufferSize--;
                }
                break;
        }
    }
}

function writeLog(line) {
    console.log(line);
    if (config.logFile) {
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