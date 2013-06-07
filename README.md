# Nagios Ops

This project was started for me to try out node.js, websockets, and zeromq.
It was built to pull data over zeromq from [NagMQ](https://github.com/jbreams/nagmq)
and create a live Nagios screen with the required data shared between the
server and clients through websockets

## Installation

    git clone git@github.com:ian-ozzie/node-nagmq.git
    npm install

## Starting the server

    node nagios.js
