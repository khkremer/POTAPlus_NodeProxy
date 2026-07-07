#!/bin/zsh
cd ~/Work/ChromeExtensions/proxy/POTAPlus_NodeProxy
# the loop restarts the connector automatically if it ever crashes
screen -S POTAPlusConnector -dm zsh -c 'while true; do node ./POTAPlusConnector.js; echo "Connector exited - restarting in 2 seconds"; sleep 2; done'

