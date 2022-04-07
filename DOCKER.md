# lw.comm-server Docker Builds

This guide assumes some familiarity with [Docker](https://www.docker.com/), if you are new to Docker please start at: https://docs.docker.com/get-started/

Docker user targets:
- dev (default)

## Dev
You can build and run lw.comm-server in Docker using the commands below.
- build development image:
```
docker build -t lw.comm-server .
```
- run image:
```
docker run -it --device=/dev/ttyUSB0 --rm -p 8000:8000 --cap-add=sys_nice lw.comm-server
```
- Connect to app: http://localhost:8000

- Change the `--device=` to point to the correct USB device if necesscary, eg `--device=/dev/ttyACM0` etc.
- To use a different port change the port mapping in the `docker run` command to `<port number>:8000` and adjust the url you connect to appropriately.

## Run in background
If you add `-d` to the docker run command it will start the container in detached mode.
You can use `docker logs -f <uuid>` to follow the output of this, and `docker stop <uuid>` to stop it.

## Allow hot plugging & selection of connected devices
**This is NOT recommended, since it involves running the container in `--privileged` mode, which is a [potential security risk](https://docs.docker.com/engine/reference/run/#runtime-privilege-and-linux-capabilities).**

_..you have been warned.._

- run image:
```
docker run -it -v /dev:/dev --rm -p 8000:8000 --cap-add=sys_nice lw.comm-server
```
- when you conenct the app you should be able to see all USB devices in the selection list

