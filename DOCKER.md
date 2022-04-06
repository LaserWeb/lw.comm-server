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
- connect to app: http://localhost:8000

## Run in background
If you add `-d` to the docker run command it will start the container in detached mode.
You can use `docker logs -f <uuid>` to follow the output of this, and `docker stop <uuid>` to stop it.
