# lw.comm-server - unified communications server for LaserWeb4

**lw.comm-server** is the unified communications server for LaserWeb. It is the gateway between the machnine and the frontend and cares about all different interfaces & firmware specific protocols, so the clients doesn't have to care about the machine controller and firmware (as far as possible).

lw.comm-server is based on nodejs 6.x.

## Communication structure
![Communication diagram](https://github.com/LaserWeb/lw.comm-server/blob/master/doc/communications-diagram.jpg)

The frontend communicates with the server over websockets. Details about the API can be found in the wiki. 
The server supports several interfaces to communicate with machines.

## Supported interfaces

### Implemented:
* Serial over **USB**
* Websocket to **ESP8266** (as WLAN to serial gateway)

### Planned:
* **Telnet** over Network (for Smoothieware olny)

## Supported firmwares
* Grbl (actual version)
* Smoothieware (actual version of firmware-cnc.bin)
* TinyG (actual version)


Please check the wiki for details about the API.

