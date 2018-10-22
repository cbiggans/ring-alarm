/* jshint esversion: 6, node: true, undef: true, unused: true */

const https = require('https');
const parse = require('url').parse;
const format = require('url').format;
const stringify = require('querystring').stringify;
const crypto = require("crypto");

const io = require('socket.io-client');
const logger = require('debug')('ring-alarm');
const logger2 = require('debug')('ring-alarm.station');

const API_VERSION = 11;
const hardware_id = crypto.randomBytes(16).toString("hex");

const formatDates = (key, value) => {
    if (value && value.indexOf && value.indexOf('.000Z') > -1) {
        return new Date(value);
    }
    return value;
};

/*
 * This converts the ID to a string, they are using large numbers for their ID's
 * and that breaks in JS since it can't math too well..
 */
const _scrub = (data) => {
    data = data.replace(/"id":(\d+),"created_at"/g, '"id":"$1","created_at"');
    return data;
};

const _validate_device = (device) => {
    if (typeof device !== 'object' || !device) {
        throw new Error('Device needs to be an object');
    }
    if (device && !device.id) {
        throw new Error('Device.id not found');
    }
};

const _validate_callback = (callback) => {
    if (typeof callback !== 'function') {
        throw new Error('Callback not defined');
    }
};

class Doorbot {
    constructor(options) {
        options = options || {};
        this.username = options.username || options.email;
        this.password = options.password;
        this.retries = options.retries || 0;
        this.timeout = options.timeout || (5 * 60 * 1000);
        this.counter = 0;
        this.userAgent = options.userAgent || 'android:com.ringapp:2.0.67(423)';
        this.token = options.token || null;
        this.oauthToken = options.oauthToken || null;
        this.alarmSockets = {};
        this.alarmCallbacks = {};
        this.seqno = 1;
        this.api_version = options.api_version || API_VERSION;

        if (!this.username) {
            throw(new Error('username is required'));
        }
        if (!this.password) {
            throw(new Error('password is required'));
        }
        this.authenticating = false;
        this.authQueue = [];
    }

    _fetch(method, url, query, body, callback) {
        logger('fetch:', this.counter, method, url);
        var d = parse(url, true);
        var altAPI;
        if (url.indexOf('http') === -1)
            d = parse('https://api.ring.com/clients_api' + url, true);
        else {
            altAPI = true;
        }
        logger('query', query);
        delete d.path;
        delete d.href;
        delete d.search;
        
        /*istanbul ignore next*/
        if (query) {
            Object.keys(query).forEach((key) => {
                d.query[key] = query[key];
            });
        }
    
        d = parse(format(d), true);
        logger('fetch-data', d);
        d.method = method;
        d.headers = d.headers || {};
        if (altAPI)
            d.headers.Authorization = "Bearer " + this.oauthToken;
        if (body) {
            body = stringify(body);
            d.headers['content-type'] = 'application/x-www-form-urlencoded';
            d.headers['content-length'] = body.length;
        }
        d.headers['user-agent'] = this.userAgent;
        logger('fetch-headers', d.headers);
        let timeoutP;
        const TIMEOUT = this.timeout;
        const req = https.request(d, (res) => {
            if (timeoutP) {
                return;
            }
            var data = '';
            res.on('data', (d) => {
                data += d;
            });
            /*istanbul ignore next*/
            res.on('error', (e) => {
                callback(e);
            });
            res.on('end', () => {
                req.setTimeout(0);
                logger('fetch-raw-data', data);
                var json,
                    e = null;
                try {
                    data = _scrub(data);
                    json = JSON.parse(data, formatDates);
                } catch (e) {
                    json = data;
                }
                logger('fetch-json', json);
                if (json.error) {
                    e = json;
                    e.status = Number(e.status);
                    json = {};
                }
                if (res.statusCode >= 400) {
                    e = new Error(`API returned Status Code ${res.statusCode}`);
                    e.code = res.statusCode;
                }
                callback(e, json, res);
            });
        });
        req.on('error', callback);
        req.setTimeout(TIMEOUT, () => {
            timeoutP = true;
            callback(new Error('An API Timeout Occurred'));
        });
        if (method === 'POST') {
            logger('fetch-post', body);
            req.write(body);
        }
        req.end();
    }

    _simpleRequest(url, method, data, callback) {
        if (typeof data === 'function') {
            callback = data;
            data = null;
        }
        /*istanbul ignore next*/
        if (data && !data.api_version) {
            data.api_version = this.api_version;
        }
        this._authenticate((e) => {
            if (e && !this.retries) {
                return callback(e);
            }
            this._fetch(method, url, {
                api_version: this.api_version,
                auth_token: this.token
            }, data, (e, res, json) => {
                /*istanbul ignore else - It's only for logging..*/
                if (json) {
                    logger('code', json.statusCode);
                    logger('headers', json.headers);
                }
                logger(e);
                if (e && e.code === 401 && this.counter < this.retries) {
                    logger('auth failed, retrying', e);
                    this.counter += 1;
                    var self = this;
                    setTimeout(() => {
                        logger('auth failed, retry', { counter: self.counter });
                        self.token = null;
                        self._authenticate(true, (e) => {
                            /*istanbul ignore next*/
                            if (e) {
                                return callback(e);
                            }
                            self._simpleRequest(url, method, callback);
                        });
                    }, 500);
                    return;
                }
                this.counter = 0;
                callback(e, res, json);
            });
        });
    }

    _authenticate(retryP, callback) {
        if (typeof retryP === 'function') {
            callback = retryP;
            retryP = false;
        }
        if (!retryP) {
            if (this.token) {
                logger('auth skipped, we have a token');
                return callback();
            }
            if (this.authenticating) {
                logger('authenticate in progress, queuing callback');
                this.authQueue.push(callback);
                return;
            }
            this.authenticating = true;
        }
        logger('authenticating with oAuth...');
        const body = JSON.stringify({
            client_id: "ring_official_android",
            grant_type: "password",
            username: this.username,
            password: this.password,
            scope: "client"
        });
        const url = parse('https://oauth.ring.com/oauth/token');
        url.method = 'POST';
        url.headers = {
            'content-type': 'application/json',
            'content-length': body.length
        };
        logger('fetching access_token from oAuth token endpoint');
        const req = https.request(url, (res) => {
            logger('access_token statusCode', res.statusCode);
            logger('access_token headers', res.headers);
            let data = '';
            res.on('data', d => {return data += d;});
            res.on('end', () => {
                let e = null;
                let json = null;
                let oauthToken = null;
                try {
                    json = JSON.parse(data);
                } catch (je) {
                    logger('JSON parse error', data);
                    logger(je);
                    e = new Error('JSON parse error from ring, check logging..');
                }
                let token = null;
                if (json && json.access_token) {
                    token = json.access_token;
                    oauthToken = token;
                    logger('authentication_token', token);
                }
                if (!token || e) {
                    logger('access_token request failed, bailing..');
                    e = e || new Error('Api failed to return an authentication_token');
                    return callback(e);
                }
                const body = JSON.stringify({
                    device: {
                        hardware_id: hardware_id,
                        metadata: {
                            api_version: this.api_version,
                        },
                        os: "android"
                    }
                });
                logger('session json', body);
                const sessionURL = `https://api.ring.com/clients_api/session?api_version=${this.api_version}`;
                logger('sessionURL', sessionURL);
                const u = parse(sessionURL, true);
                u.method = 'POST';
                u.headers = {
                    Authorization: 'Bearer ' + token,
                    'content-type': 'application/json',
                    'content-length': body.length
                };
                logger('fetching token with oAuth access_token');
                const a = https.request(u, (res) => {
                    logger('token fetch statusCode', res.statusCode);
                    logger('token fetch headers', res.headers);
                    let data = '';
                    let e = null;
                    res.on('data', d => {return data += d;});
                    res.on('end', () => {
                        let json = null;
                        try {
                            json = JSON.parse(data);
                        } catch (je) {
                            logger('JSON parse error', data);
                            logger(je);
                            e = 'JSON parse error from ring, check logging..';
                        }
                        logger('token fetch response', json);
                        const token = json && json.profile && json.profile.authentication_token;
                        if (!token || e) {
                            /*istanbul ignore next*/
                            const msg = e || json && json.error || 'Authentication failed';
                            return callback(new Error(msg));
                        }
                        //Timeout after authentication to let the token take effect
                        //performance issue..
                        var self = this;
                        setTimeout(() => {
                            self.token = token;
                            self.authenticating = false;
                            this.oauthToken = oauthToken;
                            if (self.authQueue.length) {
                                logger(`Clearing ${self.authQueue.length} callbacks from the queue`);
                                self.authQueue.forEach(_cb => {return _cb(e, token);});
                                self.quthQueue = [];
                            }
                            callback(e, token);
                        }, 1500);
                    });
                });
                a.on('error', callback);
                a.write(body);
                a.end();
            });
        });
        req.on('error', callback);
        req.write(body);
        req.end();
    }

    stations(callback) {
        _validate_callback(callback);
        this._simpleRequest('/ring_devices', 'GET', (err, result) => {
            callback(err, result && result.base_stations);
        });
    }

    _initAlarmConnection(alarmDevice, callback) {
        _validate_callback(callback);

        const self = this;
        let websocket = self._alarmSocket(alarmDevice);

        if (websocket) return;

        self._simpleRequest('https://app.ring.com/api/v1/rs/connections', 'POST', { accountId: alarmDevice.location_id },
        (e, connection) => {
            const key = alarmDevice.location_id;

            const loser = (err) => {
                const callbacks = self.alarmCallbacks[key];

                logger2(key + ': ' + err.toString());

                delete self.alarmSockets[key];
                delete self.alarmCallbacks[key];

                for (let seqno in callbacks) {
                  if (!callbacks.hasOwnProperty(seqno)) continue;

                  try {
                      logger ('cleanup seqno=' + seqno);
                      callbacks[seqno](err, alarmDevice);
                  } catch (ex) {
                      logger ('cleanup err=' + ex.stack);
                  }
                }
            };

            if (e) return callback(e, alarmDevice);

            logger2('Connecting to websocket');
            websocket = io.connect('wss://' + connection.server + '/?authcode=' + connection.authCode, { reonnection: false });

            self.alarmSockets[key] = websocket;
            self.alarmCallbacks[key] = {};
            websocket.on('connect', () => {
                logger2('Connected to websocket');
                callback();
            }).on('connect_error', (err) => {
                loser(err);
                callback(err);
            }).on('connect_timeout', (err) => {
                loser(err);
                callback(err);
            }).on('message', (message) => {
                const cb = self.alarmCallbacks[key] && self.alarmCallbacks[key][message.seq];

                logger2('Response type=' + message.msg + ' datatype=' + message.datatype + ' seq=' + message.seq);

                if (cb)
                    cb(null, alarmDevice, message);
            }).on('disconnect', () => {
                loser(new Error('websocket closed'));
            }).on('error', loser);
        });
    }

    setAlarmCallback(alarmDevice, messageType, callback) {
        _validate_callback(callback);

        const self = this;
        const websocket = self._alarmSocket(alarmDevice);

        if (!websocket) {
            return self._initAlarmConnection(alarmDevice, (err) => {
                if (err) return callback(err, alarmDevice);

                self.setAlarmCallback(alarmDevice, messageType, callback);
            });
        }

        websocket.on(messageType, (message) => {
            logger2('Received type=' + message.msg + ' datatype=' + message.datatype + ' seq=' + message.seq);

            try {
                callback(null, alarmDevice, message);
            } catch (ex) {
                logger ('callback err=' + ex.stack);
            }
        });
    }

    sendAlarmMessage(alarmDevice, messageType, messageBody, callback) {
        _validate_callback(callback);

        const self = this;
        const websocket = self._alarmSocket(alarmDevice);
        const key = alarmDevice.location_id;

        if (!websocket) {
            return self._initAlarmConnection(alarmDevice, (err) => {
                if (err) return callback(err, alarmDevice);

                self.sendAlarmMessage(alarmDevice, messageType, messageBody, callback);
            });
        }

        messageBody.seq = self.seqno++;
        self.alarmCallbacks[key][messageBody.seq] = callback;
        logger2('Transmit type=' + messageType + ' dataType=' + messageBody.msg + ' seq=' + messageBody.seq);
        return websocket.emit(messageType, messageBody);
    }

    getAlarmDevices(alarmDevice, callback) {
        _validate_callback(callback);

        const self = this;
        const websocket = this._alarmSocket(alarmDevice);

        if (!websocket) {
            return self._initAlarmConnection(alarmDevice, (err) => {
                if (err) return callback(err, alarmDevice);

                self.getAlarmDevices(alarmDevice, callback);
            });
        }

        this.sendAlarmMessage(alarmDevice, 'message', { msg: 'DeviceInfoDocGetList' }, callback);
    }

    setAlarmMode(alarmDevice, alarmPanelId, alarmMode, bypassedSensors, callback) {
        const alarmModes = [ 'all', 'some', 'none' ];
        const panelRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

        if (!panelRE.test(alarmPanelId)) throw new Error('alarmPanelId needs to be a UUID');
        if (alarmModes.indexOf(alarmMode) === -1) throw new Error('alarmMode needs to be in ' + JSON.stringify(alarmModes));
        if (!bypassedSensors) bypassedSensors = [];
        else if (!Array.isArray(bypassedSensors)) throw new Error('bypassedSensors needs to be an array');
        _validate_callback(callback);

        const self = this;
        const websocket = self._alarmSocket(alarmDevice);

        if (!websocket) {
            return self._initAlarmConnection(alarmDevice, (err) => {
                if (err) return callback(err, alarmDevice);

                self.sendAlarmModel(alarmDevice, alarmPanelId, alarmMode, bypassedSensors, callback);
            });
        }

        self.sendAlarmMessage(alarmDevice, 'message', {
            msg: 'DeviceInfoSet',
            datatype: 'DeviceInfoSetType',
            body: [ { zid: alarmPanelId,
                      command: { v1: [ { commandType: 'security-panel.switch-mode',
                                         data: { mode: alarmMode, bypass: bypassedSensors } } ] } } ]
        }, callback);
    }

    closeAlarmConnection(alarmDevice) {
        const websocket = this._alarmSocket(alarmDevice);
        const key = alarmDevice.location_id;

        if (!websocket) return;

        delete this.alarmSockets[key];
        delete this.alarmCallbacks[key];
        websocket.emit('terminate', {});
        websocket.disconnect(true);
        websocket.close();
    }

    _alarmSocket(alarmDevice) {
        _validate_device(alarmDevice);

        const key = alarmDevice.location_id;
        if (!key) throw new Error('alarmDevice.location_id not found');

        return this.alarmSockets[key];
    }
}

module.exports = function(options) {
    return new Doorbot(options);
};
