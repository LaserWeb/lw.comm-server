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
var telnet = require('telnet-client');
var WebSocket = require('ws');
var nstatic = require('node-static');
var url = require('url');
var util = require('util');
var chalk = require('chalk');
var request = require('request'); // proxy for remote webcams
var fs = require('fs');

//var EventEmitter = require('events').EventEmitter;
//var qs = require('querystring');
//var http = require('http');

var logFile;
var connections = [];
var gcodeQueue = [];
var portType; 
var port, isConnected, connectedTo;
var telnetSocket, telnetConnected, telnetIP; 
var espSocket, espConnected, espIP;
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
    writeLog(chalk.green('  update accordingly by running') + chalk.cyan('git pull'));
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
            appSocket.emit('activePorts', port.path + ',' + port.options.baudRate);
            appSocket.emit('connectStatus', 'opened:' + port.path);
        }
    });

    appSocket.on('connectTo', function (data) { // If a user picks a port to connect to, open a Node SerialPort Instance to it
        data = data.split(',');
        writeLog(chalk.yellow('WARN:') + chalk.blue('Connecting to ' + data));
        if (!isConnected) {
            portType = data[0];
            switch (portType) {
                case 'usb':
                    port = new SerialPort(data[1], {
                        parser: serialport.parsers.readline("\n"),
                        baudrate: parseInt(data[2])
                    });
                    io.sockets.emit('connectStatus', 'opening:' + port.path);

                    // Serial port events -----------------------------------------------
                    port.on('open', function () {
                        io.sockets.emit('activePorts', port.path + ',' + port.options.baudRate);
                        io.sockets.emit('connectStatus', 'opened:' + port.path);
                        setTimeout(function() { //wait for controller to be ready
                            if (!firmware) { // Grbl should be allready retected
                                port.write('version\n'); // Check if it's Smoothieware?
                                setTimeout(function() {  // Wait for Smoothie to answer
                                    if (!firmware) {     // If still not set
                                        port.write('$fb\n'); // Check if it's TinyG
                                    }
                                }, 500);
                            }
                        }, 500);
                        // port.write("M115\n");    // Lets check if its Marlin?
                        writeLog(chalk.yellow('WARN:') + 'Connected to ' + port.path + ' at ' + port.options.baudRate);
                        isConnected = true;
                        connectedTo = port.path;

                        // Start interval for qCount messages to appSocket clients
                        queueCounter = setInterval(function () {
                            io.sockets.emit('qCount', gcodeQueue.length);
                        }, 500);
                    });

                    port.on('close', function () { // open errors will be emitted as an error event
                        clearInterval(queueCounter);
                        clearInterval(statusLoop);
                        io.sockets.emit('connectStatus', 'closed:');
                        io.sockets.emit('connectStatus', 'Connect');
                        isConnected = false;
                        connectedTo = false;
                        firmware = false;
                        writeLog(chalk.yellow('WARN:') + chalk.blue('Port closed'));
                    });

                    port.on('error', function (err) { // open errors will be emitted as an error event
                        writeLog(chalk.yellow('ERROR:') + chalk.blue(err.message));
                        io.sockets.emit("data", err.message);
                    });

                    port.on('data', function (data) {
                        writeLog('Recv: ' + data);
                        if (data.indexOf('{') === 0) { // TinyG response
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
                            if (jsObject.hasOwnProperty('fb')) { // Check if it's TinyG
                                firmware = 'tinyg';
                                fVersion = jsObject.fb;
                                writeLog('TinyG detected (' + fVersion + ')');
                                // Start intervall for status queries
                                statusLoop = setInterval(function () {
                                    if (isConnected) {
                                        port.write('{"sr":null}');
                                    }
                                }, 250);
                            }
                        }
                        if (data.indexOf('Grbl') === 0) { // Check if it's Grbl
                            firmware = 'grbl';
                            fVersion = data.substr(5, 4); // get version
                            writeLog('GRBL detected (' + fVersion + ')');
                            // Start intervall for status queries
                            statusLoop = setInterval(function () {
                                if (isConnected) {
                                    port.write('?');
                                }
                            }, 250);
                        }
                        if (data.indexOf('LPC176') >= 0) { // LPC1768 or LPC1769 should be Smoothie
                            firmware = 'smoothie';
                            var startPos = data.search(/version:/i) + 9;
                            fVersion = data.substr(startPos).split(/,/, 1);
                            startPos = data.search(/Build date:/i) + 12;
                            fDate = new Date(data.substr(startPos).split(/,/, 1));
                            var dateString = fDate.toDateString();
                            writeLog('Smoothieware detected (' + fVersion + ', ' + dateString + ')');
                            // Start intervall for status queries
                            statusLoop = setInterval(function () {
                                if (isConnected) {
                                    port.write('?');
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
                        io.sockets.emit('data', data);
                    });
                    break;
                
                case 'telnet':
                    telnetSocket = new telnet();
                    var params = {
                      host: data[1],
                      port: 23,
                      shellPrompt: '> ',
                      //timeout: 1500,
                      // removeEcho: 4 
                    };
                    telnetSocket.connect(params);
                    io.sockets.emit('connectStatus', 'opening:' + data[1]);

                    // Telnet connection events -----------------------------------------------
                    telnetSocket.on('ready', function (prompt) {
                        telnetSocket.exec('version', function (err, response) {
                            writeLog('Telnet:' + response);
                        });
                    });

                    telnetSocket.on('timeout', function () {
                        writeLog(chalk.yellow('WARN:') + 'Telnet socket timeout!')
                        telnetSocket.end();
                    });

                    telnetSocket.on('close', function () {
                        writeLog(chalk.yellow('WARN:') + 'Telnet connection closed');
                    });         
                    break;
                    
                case 'esp8266':
                    espIP = data[1];
                    espSocket = new WebSocket('ws://'+espIP+'/'); // connect to ESP websocket
                    io.sockets.emit('connectStatus', 'opening:' + espIP);
                    
                    // ESP socket evnets -----------------------------------------------        
                    espSocket.on('open', function (e) {
                        io.sockets.emit('connectStatus', 'opened:' + espIP);
                        writeLog(chalk.yellow('WARN:') + chalk.blue('ESP connected @ ' + espIP));
                        espConnected = true;
                        espSocket.send('version\n');
                        statusLoop = setInterval(function () {
                            if (espConnected) {
                                espSocket.send('?');
                            } else {
                                clearInterval(statusLoop);
                                writeLog(chalk.yellow('WARN:') + 'Unable to send gcode (not connected to ESP): ' + e);
                            }
                        }, 250);
                    });

                    espSocket.on('close', function (e) {
                        espConnected = false;
                        espIP = false;
                        paused = false;
                        blocked = false;
                        io.sockets.emit('connectStatus', 'Connect');
                        writeLog(chalk.yellow('WARN:') + chalk.blue('ESP connection closed'));
                    });

                    espSocket.on('error', function (e) {
                        io.sockets.emit('error', e.message);
                        writeLog(chalk.red('ERROR:') + 'ESP error: ' + e.message);
                    });

                    espSocket.on('message', function (e) {
                        //writeLog('ESP:' + e);
                        //io.sockets.emit("data", data);
//                        var data = "";
//                        var i;
//                        if (e.data instanceof ArrayBuffer) {
//                            var bytes = new Uint8Array(e.data);
//                            for (i = 0; i < bytes.length; i++) {
//                                data += String.fromCharCode(bytes[i]);
//                            }
//                        } else {
//                            data = e.data;
//                        }
//
//                        espBuffer += data;
//                        var split = espBuffer.split()"\n");
//                        espBuffer = split.pop(); //last not fin data back to buffer
//                        // writeLog(split)
//                        for (i = 0; i < split.length; i++) {
//                            var response = split[i];
//                            writeLog('ESP:' + response);
//                            if (response.indexOf('Grbl') === 0) { // Check if it's Grbl
//                                firmware = 'grbl';
//                                fVersion = response.substr(5, 4); // get version
//                                writeLog('GRBL detected (' + fVersion + ')');
//                                // Start intervall for status queries
//                                statusLoop = setInterval(function () {
//                                    if (isConnected) {
//                                        port.write('?');
//                                    }
//                                }, 250);
//                            }
//                            if (response.indexOf('LPC176') >= 0) { // LPC1768 or LPC1769 should be Smoothie
//                                firmware = 'smoothie';
//                                var startPos = response.search(/Version:/i) + 9;
//                                fVersion = response.substr(startPos).split(/,/, 1);
//                                writeLog('Smoothieware detected (' + fVersion + ')');
//                                // Start intervall for status queries
//                                statusLoop = setInterval(function () {
//                                    if (isConnected) {
//                                        port.write('?');
//                                    }
//                                }, 250);
//                            }
//                            if (response.indexOf("ok") === 0) { // Got an OK so we are clear to send
//                                blocked = false;
//                                if (firmware === 'grbl') {
//                                    grblBufferSize.shift();
//                                }
//                                send1Q();
//                            }
//                            if (response.indexOf("error") === 0) {
//                                if (firmware === 'grbl') {
//                                    grblBufferSize.shift();
//                                }
//                            }
//                            io.sockets.emit("data", response);
//                        }
                    });
                    break;
            }
        } else {
            //io.sockets.emit('connectStatus', 'resume:' + port.path);
            io.sockets.emit('connectStatus', 'opened:' + port.path);

            // port.write(String.fromCharCode(0x18));   // Lets check if its Grbl?
            // port.write("version\n");                 // Lets check if its Smoothieware?
            // port.write("$fb\n");                     // Lets check if its TinyG
            // port.write("M115\n");                    // Lets check if its Marlin?
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
                io.sockets.emit('running', gcodeQueue.length);
            }
            send1Q();
        } else {
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.yellow('WARN:') + chalk.blue('Port closed!'));
        }
    });

    appSocket.on('serialSend', function (data) {
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
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.yellow('WARN:') + chalk.blue('Port closed!'));
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
                        port.write(String.fromCharCode(parseInt(code)));
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
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.yellow('WARN:') + chalk.blue('Port closed!'));
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
                        port.write(String.fromCharCode(parseInt(code)));
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
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.yellow('WARN:') + chalk.blue('Port closed!'));
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
                                    //appSocket.emit('laserTest', 0); //-> Grbl get it with status report
                                }
                                send1Q();
                                break;
                            case 'smoothie':
                                addQ('fire ' + power + '\n');
                                laserTestOn = true;
                                appSocket.emit('laserTest', power);
                                if (duration > 0) {
                                    var divider = 1;
                                    if (fDate >= new Date('2017-01-02')) {
                                        divider = 1000;
                                    }
                                    addQ('G4P' + duration / divider + '\n');
                                    addQ('fire off');
                                    setTimeout(function() {
                                        laserTestOn = false;
                                        appSocket.emit('laserTest', 0);
                                    }, duration );
                                }
                                send1Q();
                                break;
                            case 'tinyg':
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
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.yellow('WARN:') + chalk.blue('Port closed!'));
        }
    });

    appSocket.on('pause', function (data) {
        if (isConnected) {
            paused = true;
            writeLog(chalk.red('PAUSE'));
            switch (firmware) {
                case 'grbl':
                    port.write('!'); // Send hold command
                    if (fVersion === '1.1d') {
                        port.write(String.fromCharCode(0x9E)); // Stop Spindle/Laser
                    }
                    break;
                case 'smoothie':
                    port.write('M600\n'); // Laser will be turned off by smoothie (in default config!)
                    break;
                case 'tinyg':
                    port.write('!'); // Send hold command
                    break;
            }
            io.sockets.emit('connectStatus', 'paused:' + port.path);
        } else {
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.yellow('WARN:') + chalk.blue('Port closed!'));
        }
    });

    appSocket.on('unpause', function (data) {
        if (isConnected) {
            writeLog(chalk.red('UNPAUSE'));
            io.sockets.emit('connectStatus', 'unpaused:' + port.path);
            switch (firmware) {
                case 'grbl':
                    port.write('~'); // Send resume command
                    break;
                case 'smoothie':
                    port.write('M601\n');
                    break;
                case 'tinyg':
                    port.write('~'); // Send resume command
                    break;
            }
            paused = false;
            send1Q(); // restart queue
        } else {
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.yellow('WARN:') + chalk.blue('Port closed!'));
        }
    });

    appSocket.on('stop', function (data) {
        if (isConnected) {
            paused = true;
            writeLog(chalk.red('STOP'));
            switch (firmware) {
                case 'grbl':
                    port.write('!'); // hold
                    if (fVersion === '1.1d') {
                        port.write(String.fromCharCode(0x9E)); // Stop Spindle/Laser
                    }
                    gcodeQueue.length = 0; // dump the queye
                    grblBufferSize.length = 0; // dump bufferSizes
                    blocked = false;
                    paused = false;
                    port.write(String.fromCharCode(0x18)); // ctrl-x
                    break;
                case 'smoothie':
                    //port.write('!');              // hold
                    paused = true;
                    port.write(String.fromCharCode(0x18)); // ctrl-x
                    gcodeQueue.length = 0; // dump the queye
                    grblBufferSize.length = 0; // dump bufferSizes
                    blocked = false;
                    paused = false;
                    break;
                case 'tinyg':
                    port.write('!'); // hold
                    port.write('%'); // dump TinyG queue
                    gcodeQueue.length = 0; // dump LW queue
                    grblBufferSize.length = 0; // dump bufferSizes
                    tinygBufferSize = 4;
                    blocked = false;
                    paused = false;
                    break;
            }
            laserTestOn = false;
            io.sockets.emit('connectStatus', 'stopped:' + port.path);
        } else {
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.yellow('WARN:') + chalk.blue('Port closed!'));
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
                            port.write('$X\n');
                            break;
                        case 'smoothie':
                            port.write('$X\n');
                            break;
                        case 'tinyg':
                            port.write('$X/n'); // resume
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
                            port.write('$X\n');
                            break;
                        case 'smoothie':
                            port.write('$X\n'); //M999
                            break;
                        case 'tinyg':
                            port.write('%'); // flush tinyg quere
                            tinygBufferSize = TINYG_RX_BUFFER_SIZE;
                            port.write('~'); // resume
                            break;
                    }
                    break;
            }
        } else {
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.yellow('WARN:') + chalk.blue('Port closed!'));
        }
    });


    appSocket.on('getFirmware', function (data) { // Deliver Firmware to Web-Client
        appSocket.emit('firmware', firmware + ',' + fVersion + ',' + fDate);
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
    
    appSocket.on('closePort', function (data) { // Close machine port and dump queue
        if (isConnected) {
            writeLog(chalk.yellow('WARN:') + chalk.blue('Closing Port ' + port.path));
            io.sockets.emit('connectStatus', 'closing:' + port.path);
            port.write(String.fromCharCode(0x18)); // ctrl-x
            gcodeQueue.length = 0; // dump the queye
            grblBufferSize.length = 0; // dump bufferSizes
            tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
            clearInterval(queueCounter);
            clearInterval(statusLoop);
            port.close();
        } else {
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.yellow('WARN:') + chalk.blue('Port already closed'));
        }
    });

    appSocket.on('closeTelnet', function (data) { // Close socket connection to ESP
        if (telnetConnected) {
            writeLog(chalk.yellow('WARN:') + chalk.blue('Closing Telnet @ ' + telnetIP));
            io.sockets.emit('connectStatus', 'closing:' + telnetIP);
            telnetSocket.send(String.fromCharCode(0x18)); // ctrl-x
            gcodeQueue.length = 0; // dump the queye
            grblBufferSize.length = 0; // dump bufferSizes
            tinygBufferSize = TINYG_RX_BUFFER_SIZE; // reset tinygBufferSize
            clearInterval(queueCounter);
            clearInterval(statusLoop);
            telnetSocket.close();
        } else {
            io.sockets.emit('connectStatus', 'Connect');
            writeLog(chalk.yellow('WARN:') + chalk.blue('Telnet connection already closed'));
        }
    });

    appSocket.on('closeEsp', function (data) { // Close socket connection to ESP
        if (espConnected) {
            writeLog(chalk.yellow('WARN:') + chalk.blue('Closing ESP @ ' + espIP));
            io.sockets.emit('connectStatus', 'closing:' + espIP);
            espSocket.send(String.fromCharCode(0x18)); // ctrl-x
            gcodeQueue.length = 0; // dump the queye
            grblBufferSize.length = 0; // dump bufferSizes
            tinygBufferSize = 4; // reset tinygBufferSize
            clearInterval(queueCounter);
            clearInterval(statusLoop);
            espSocket.close();
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
                        port.write(gcode + '\n');
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
                        if (gcode.indexOf('fire ') === -1 && gcode.indexOf('G4') === -1) {
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
                        port.write(gcodeLine + '\n');
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
                        port.write(gcode + '\n');
                        lastSent = gcode;
                        writeLog('Sent: ' + gcode + ' Q: ' + gcodeQueue.length);
                    }
                }
                break;
            case 'tinyg':
                while (tinygBufferSize > 0 && gcodeQueue.length > 0 && !blocked && !paused) {
                    gcode = gcodeQueue.shift();
                    // Optimise gcode by stripping spaces - saves a few bytes of serial bandwidth, and formatting commands vs gcode to upper and lowercase as needed
                    gcode = gcode.replace(/\s+/g, '');
                    writeLog('Sent: ' + gcode + ' Q: ' + gcodeQueue.length);
                    lastSent = gcode;
                    port.write(gcode + '\n');
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
        logFile.write(time + ' ' + line + '\r\n');
    }
}