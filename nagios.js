#!/usr/bin/env node
"use strict";

// pull in configuration data
var config = require('./config');

/* {{{ pull in modules and init variables */
// initialise global variables
var active = false,
    state  = 0;

// initialise socket.io
var io = require('socket.io')(config.web.port);

// load zmq to communicate with nagmq host
var zmq     = require('zmq'),
    nagios  = zmq.socket('sub'),
    request = zmq.socket('req');
// connect to subscriber socket
nagios.connect('tcp://' + config.nagios.host + ':' + config.nagios.subscriber);
nagios.subscribe('');
// initialise request socket
request.connect('tcp://' + config.nagios.host + ':' + config.nagios.requester);

// initialise mongodb vars
var mongo    = require('mongodb'),
    server   = new mongo.Server(config.mongo.host, config.mongo.port, {auto_reconnect: true}),
    db       = new mongo.Db('nagios', server, {strict: true}),
    hosts    = new mongo.Collection(db, 'hosts'),
    services = new mongo.Collection(db, 'services');

// open mongodb
db.open(function(err, db) {
    if(!err) {
        console.log("MongoDB is online!");
    }
});
/* }}} */

/* {{{ Create priority map for values -> class names */
var priorityMap = {
    0: 'hard recovered',
    1: 'hard acknowledged',
    2: 'hard acknowledged',
    3: 'hard notice',
    4: 'hard status',
    5: 'hard warning',
    6: 'soft warning',
    7: 'hard critical',
    8: 'soft critical',
    9: 'hard down'
};
/* }}} */

/* {{{ create priority from issues found */
function getPriority(service, state, cur_attempts, max_attempts, acknowledged) {
    if (!state) {
        return 0;
    } else if (service == 'DOWN') {
        if (acknowledged) {
            return 2;
        } else {
            return 9;
        }
    } else if (acknowledged) {
        return 1;
    } else if (cur_attempts == max_attempts) {
        if (state == 3) {
            return 7;
        } else if (state == 2) {
            return 7;
        } else if (state == 1) {
            return 5;
        }
    } else {
        if (state == 3) {
            return 8;
        } else if (state == 2) {
            return 8;
        } else if (state == 1) {
            return 6;
        }
    }
}
/* }}} */

/* {{{ handle clients */
io.sockets.on('connection', function (socket) {
    /* {{{ push a full sync state when requested */
    socket.on('sync issues', function () {
        services.find({'state': {$ne: 0}}).toArray(function (err, issues) {
            var returnHash = { };
            if (err) {
                console.log('Error searching for problem services. Details:');
                console.log(err);
            } else if (issues) {
                for (var i = issues.length; i--;) {
                    issues[i].priority = getPriority(issues[i].service, issues[i].state, issues[i].current_attempt, issues[i].max_attempts, issues[i].acknowledged);

                    var hostId = issues[i].host;
                    var serviceId = issues[i].service;
                    if (typeof returnHash[hostId] == 'undefined') {
                        returnHash[hostId] = { };
                    }

                    returnHash[hostId][serviceId] = issues[i];
                }
            }
            socket.emit('full sync', returnHash);
        });
    });
    /* }}} */

    /* {{{ push the priority map to the clients as they connect */
    socket.on('get priorities', function () {
        socket.emit('priority map', priorityMap);
    });
    /* }}} */

    /* {{{ handle clients requesting host information */
    socket.on('get host', function (hostname) {
        hosts.findOne({'host': hostname}, function(err, host) {
            if (err) {
                console.log('Error searching for ' + hostname + '. Details:');
                console.log(err);
            } else if (host) {
                socket.emit('host details', { 'host': hostname, data: host });
            } else {
                console.log('An error has occured. No match for ' + hostname);
            }
        });
    });
    /* }}} */
});
/* }}} */

/* {{{ handle requested data */
request.on("message", function (reply) {
    var data = JSON.parse(reply.toString());
    if (Object.keys(data).length > 100) {
        console.log(Object.keys(data).length + ' objects found, re-populating hosts + services');
        console.log('Clearing hosts');
        hosts.remove(function(err, result) {
            console.log('Cleared ' + result + ' hosts. Clearing service.');
            services.remove(function(err, result) {
                console.log('Cleared ' + result + ' services. Repopulating.');
                Object.keys(data).forEach(function(key) {
                    if (data[key].type == 'host') {
                        /* {{{ host key, split them into host and alive service */
                        var host = {
                            host:    data[key].host_name,
                            alias:   data[key].alias,
                            address: data[key].address,
                            icon:    data[key].icon_image,
                            type:    data[key].icon_image_alt
                        };
                        hosts.insert(host, function(err) {
                            if (err) {
                                console.log('Error saving host:');
                                console.log(err);
                            }
                        });

                        var hostService = {
                            host:              data[key].host_name,
                            service:           'DOWN',
                            state:             data[key].current_state,
                            last_state:        data[key].last_state,
                            last_hard_state:   data[key].last_hard_state,
                            output:            data[key].plugin_output,
                            long_output:       data[key].long_plugin_output,
                            perf_data:         data[key].perf_data,
                            current_attempt:   data[key].current_attempt,
                            max_attempts:      data[key].max_attempts,
                            last_check:        data[key].last_check,
                            last_time_ok:      data[key].last_time_up,
                            last_state_change: data[key].last_state_change,
                            flapping:          data[key].is_flapping,
                            acknowledged:      data[key].problem_has_been_acknowledged,
                            check_in_progress: false,
                            command_line:      null
                        };

                        services.insert(hostService, function(err) {
                            if (err) {
                                console.log('Error saving service:');
                                console.log(err);
                            }
                        });
                        /* }}} */
                    } else if (data[key].type == 'service') {
                        /* {{{ service key, save it */
                        var service = {
                            host:              data[key].host_name,
                            service:           data[key].service_description,
                            state:             data[key].current_state,
                            last_state:        data[key].last_state,
                            last_hard_state:   data[key].last_hard_state,
                            output:            data[key].plugin_output,
                            long_output:       data[key].long_plugin_output,
                            perf_data:         data[key].perf_data,
                            current_attempt:   data[key].current_attempt,
                            max_attempts:      data[key].max_attempts,
                            last_check:        data[key].last_check,
                            last_time_ok:      data[key].last_time_ok,
                            last_state_change: data[key].last_state_change,
                            flapping:          data[key].is_flapping,
                            acknowledged:      data[key].problem_has_been_acknowledged,
                            check_in_progress: false,
                            command_line:      null
                        };
                        services.insert(service, function(err) {
                            if (err) {
                                console.log('Error saving service:');
                                console.log(err);
                            }
                        });
                        /* }}} */
                    }
                });
                console.log('Populating complete, activating event listener.');

                active = true;
            });
        });
    }
});
/* }}} */

/* {{{ handle nagios messages */
nagios.on("message", function(reply, args, message) {
    var type = reply.toString().split(' ')[0];
    if (!active && type != 'program_status') { return; }

    if (type === '') {
        return;
    }

    var data = JSON.parse(message);
    var id;

    // check if the message is for the status of zmq
    switch (type) {
        case 'program_status':
            /* {{{ program status handling */
            // check the status start time against our recorded data set
            if (state != data.program_start) {
                // doesn't match, disable activity and rebuild data
                active = false;
                console.log('Session doesn\'t match data that we are aware of. Rebuilding host keys');
                // request current data set from zmq
                request.send(JSON.stringify(config.request));
                // store our new state
                state = data.program_start;
            }
            var myDate = new Date(data.timestamp.tv_sec *1000);
            if (active) {
                services.find({check_in_progress: true}).count(function (e, count) {
                    console.log('App is active. Last check run at ' + myDate.toLocaleString() + '. Currently ' + count + ' checks pending results.');
                });
            } else {
                console.log('App is inactive. Waiting on data to be rebuilt.');
            }
            /* }}} */
            break;
        case 'host_check_initiate':
            /* {{{ host check initiated handling */
            id = { host: data.host_name, service: 'DOWN' };
            services.findOne(id, function(err, service) {
                if (err) {
                    console.log('Error finding service. Details:');
                    console.log(err);
                } else if (service) {
                    var update = {
                        check_in_progress: true,
                        command_line: data.command_line
                    };

                    if (data.last_state !== 0) {
                        io.sockets.emit('check init', { 'host': id.host, 'service': id.service });
                    }

                    services.update(id, { $set: update }, function(err) {
                        if (err) {
                            console.log('An error has occured updating service. Details:');
                            console.log(err);
                            console.log('Our request object:');
                            console.log({'id': id, 'update':update});
                        }
                    });
                } else {
                    console.log('An error has occured. No match for ' + id.host);
                }
            });
            /* }}} */
            break;
        case 'host_check_processed':
            /* {{{ host check complete handling */
            id = { host: data.host_name, service: 'DOWN' };
            services.findOne(id, function(err, service) {
                if (err) {
                    console.log('Error finding service. Details:');
                    console.log(err);
                } else if (service) {
                    var update = {
                        check_in_progress: false,
                        output:            data.output,
                        long_output:       data.long_output,
                        perf_data:         data.perf_data,
                        current_attempt:   data.current_attempt,
                        state:             data.state,
                        last_state:        data.last_state,
                        last_hard_state:   data.last_hard_state,
                        last_check:        data.last_check,
                        last_state_change: data.last_state_change
                    };
                    if (update.state === 0) {
                        update.last_time_ok = update.last_check;
                    }

                    if (data.state !== 0 || data.state != data.last_state) {
                        for (var attrname in update) {
                            service[attrname] = update[attrname];
                        }
                        if (data.state != data.last_state) {
                            console.log('Host ' + id.host + ' has changed state from ' + data.last_state + ' to ' + data.state);
                        }

                        service.priority = getPriority(id.service, service.state, service.current_attempt, service.max_attempts, service.acknowledged);

                        io.sockets.emit('state update', { 'host': id.host, 'service': id.service, 'data': service });
                    }

                    services.update(id, { $set: update }, function(err) {
                        if (err) {
                            console.log('An error has occured updating service. Details:');
                            console.log(err);
                            console.log('Our request object:');
                            console.log({'id': id, 'update':update});
                        }
                    });
                } else {
                    console.log('An error has occured. No match for ' + data.host_name);
                }
            });
            /* }}} */
            break;
        case 'service_check_initiate':
            /* {{{ service check initiated handling */
            id = { host: data.host_name, service: data.service_description };
            services.findOne(id, function(err, service) {
                if (err) {
                    console.log('Error finding service. Details:');
                    console.log(err);
                } else if (service) {
                    var update = {
                        check_in_progress: true,
                        command_line: data.command_line
                    };

                    if (data.last_state !== 0) {
                        io.sockets.emit('check init', { 'host': id.host, 'service': id.service });
                    }

                    services.update(id, { $set: update }, function(err) {
                        if (err) {
                            console.log('An error has occured updating service. Details:');
                            console.log(err);
                            console.log('Our request object:');
                            console.log({'id': id, 'update':update});
                        }
                    });
                } else {
                    console.log('An error has occured. No match for ' + id.host + ' with the service ' + id.service);
                }
            });
            /* }}} */
            break;
        case 'service_check_processed':
            /* {{{ service check processed handling */
            id = { host: data.host_name, service: data.service_description };
            services.findOne(id, function(err, service) {
                if (err) {
                    console.log('Error finding service. Details:');
                    console.log(err);
                } else if (service) {
                    var update = {
                        check_in_progress: false,
                        output:            data.output,
                        long_output:       data.long_output,
                        perf_data:         data.perf_data,
                        current_attempt:   data.current_attempt,
                        state:             data.state,
                        last_state:        data.last_state,
                        last_hard_state:   data.last_hard_state,
                        last_check:        data.last_check,
                        last_state_change: data.last_state_change
                    };

                    if (data.state === 0) {
                        update.last_time_ok = update.last_check;
                    }

                    if (data.state !== 0 || data.state != data.last_state) {
                        for (var attrname in update) {
                            service[attrname] = update[attrname];
                        }

                        if (data.state != data.last_state) {
                            console.log('Host ' + id.host + ' running ' + id.service + ' has changed state from ' + data.last_state + ' to ' + data.state);
                        }

                        service.priority = getPriority(id.service, service.state, service.current_attempt, service.max_attempts, service.acknowledged);

                        io.sockets.emit('state update', { 'host': id.host, 'service': id.service, 'data': service });
                    }

                    services.update(id, { $set: update }, function(err) {
                        if (err) {
                            console.log('An error has occured updating service. Details:');
                            console.log(err);
                            console.log('Our request object:');
                            console.log(service);
                        }
                    });
                } else {
                    console.log('An error has occured. No match for ' + data.host_name);
                }
            });
            /* }}} */
            break;
        case 'comment_add':
            // Currently not doing anything with comments
            break;
        case 'comment_delete':
            // Currently not doing anything with comments
            break;
        case 'notification_start':
            // Currently not doing anything with notifications
            break;
        case 'eventloopend':
            // Currently not doing anything with event loops
            break;
        case 'statechange':
            // Currently detecting this manually from the state events
            break;
        default:
            // message received and processing is active
            if (config.debug) {
                console.log(type);
                console.log(data);
            }
            break;
        // Type switch completed
    }
});
/* }}} */

/* {{{ clean up on exit */
process.on('SIGINT', function() {
    nagios.close();
    request.close();
    db.close();
    // Need to handle socket.io so that this exits cleanly without process.exit();
    process.exit();
});
/* }}} */

/* vim: se expandtab ts=4 sts=4 sw=4 fdm=marker : */
