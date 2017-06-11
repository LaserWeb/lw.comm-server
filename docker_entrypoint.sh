#!/bin/bash

cd /laserweb

http-server app &
nice -n -20 npm start
