FROM node:16-bullseye AS base
#FROM resin/raspberrypi3-node:10

ADD config.js grblStrings.js firmwareFeatures.js LICENSE lw.comm-server.service package.json README.md server.js version.txt /laserweb/
ADD app /laserweb/app/

# Set up Apt, install build tooling and udev
RUN apt update
RUN apt install -y build-essential udev

# Expose the port the container will serve on
EXPOSE 8000

FROM base AS comm-server

# Build lw.comm-server
RUN cd /laserweb && npm install

FROM comm-server AS dev

# Add the start script
ADD docker_entrypoint.sh /

# Entrypoint (defaulted)
ENTRYPOINT ["/docker_entrypoint.sh"]
CMD []

# Bash shell for debug
from comm-server as bash
ENTRYPOINT ["/bin/bash"]
