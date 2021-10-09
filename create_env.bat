@echo off
title LaserWeb .env file creator
echo Checking if .env file already exists...
if not exist ".env" (
    echo File doesn't exist: creating .env file and adding RESET_ON_CONNECT=1
    echo RESET_ON_CONNECT=1 > .env
) else (
    echo File exists: adding RESET_ON_CONNECT=1
    echo RESET_ON_CONNECT=1 >> .env
)
pause