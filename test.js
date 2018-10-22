#!/usr/bin/env node

/* jshint esversion: 6, undef: true, unused: true, laxcomma: true */

/*
 *
 * To use this: npm install async doorbot
 *
 */

const RingAPI = require('.');

const ring = RingAPI({
  email: process.env.RING_USERNAME || 'your@email.com',
  password: process.env.RING_PASSPHRASE || '12345',
});

const oops = (s) => {
  console.log(s);
  process.exit(1);
};

ring.stations((err, stations) => {
  if (err) oops('ring.stations: ' + err.toString);

  const fetch = (station, callback) => {
    console.log('station=' + JSON.stringify(station, null, 2));
    
    const now = new Date().getTime();
    const params = { deviceType                 : 'SecuritySystem'
                   , deviceId                   : station.location_id
                   , manufacturer               : 'Ring'
                   , model                      : station.kind
                   , name                       : station.description
                   , serialNumber               : station.id.toString()
                   , firmwareRevision           : station.firmware_version

                   , statusActive               : true

                   , securitySystemAlarmType    : 'TBD: 0(alarm conditions are cleared) OR 1(alarm type not known)'
                   , devices                    : []
                   };

    ring.getAlarmDevices(station, (err, station, message) => {
      console.log('getAlarmDevices: errP=' + (!!err) + ' station=' + station.location_id);
      if (err) {
        console.log(err.toString() + '\n\n');
        return fetch(station, callback);
      }

      message.body.forEach((device) => {
        const info = device.general && device.general.v2;
        const context = device.device && device.device.v1;

        if (!(info && context)) return;
        if (info.deviceType === 'hub.redsky') {
          if (context.version) {
            params.firmwareRevision = context.version.softwareVersion + ' (' + context.version.buildNumber + ')';
          }
          if (info.tamperStatus) params.statusTampered = (info.tamperStatus === 'ok') ? 'NOT_TAMPERED' : 'TAMPERED';
        } else if ((info.deviceType === 'security-panel') || (info.deviceType === 'security-keypad')) {
          if (info.name) params.name = info.name;
//        if (info.tamperStatus) params.statusTampered = (info.tamperStatus === 'ok') ? 'NOT_TAMPERED' : 'TAMPERED';
          if (context.mode) {
            params.securitySystemCrrentState = params.securitySystemTargetState =
              { all: 'AWAY_ARM', some: 'STAY_ARM', none: 'DISARMED' }[context.mode] || '???';
          }
        }

        device = { deviceType       : info.deviceType === 'sensor.contact' ? 'ContactSensor' : 'MotionSensor'
                 , deviceId         : info.zid
                 , manufacturer     : info.manufacturerName
                 , model            : info.deviceType
                 , name             : info.name
                 , serialNumber     : info.serialNumber
                 , firmwareRevision : info.fingerprint
                 };
        if ((!device.manufacturer) || (!device.serialNumber) || ((info.deviceType !== 'sensor.contact') && (info.deviceType !== 'sensor.motion'))) {
          console.log('deviceType=' + info.deviceType +
                      ((info.deviceType.indexOf('sensor.') === 0) ? (' ' + JSON.stringify({ info, context }, null, 2)) : '')
                     );
          return;
        }

        info.lastCommTime = new Date(info.lastCommTime).getTime();
        info.nextExpectedWakeup = new Date(info.nextExpectedWakeup).getTime();
        info.pollInterval = parseInt(info.pollInterval) * 1000;

        if (isNaN(info.pollInterval) || isNaN(info.nextExpectedWakeup) || isNaN(info.lastCommTime)) {
          return console.log('deviceType=' + info.deviceType + ' ' + JSON.stringify({ info, context }, null, 2));
        }

        device.statusActive = (info.lastCommTime + info.pollInterval) >= now;

        if (info.deviceType === 'sensor.contact') device.contactSensorState = context.faulted ? 'NOT_DETECTED' : 'DETECTED';
        else if (info.deviceType === 'sensor.motion') device.motionDetected = context.faulted;

        if (info.tamperStatus) device.statusTampered = (info.tamperStatus === 'ok') ? 'NOT_TAMPERED' : 'TAMPERED';
        if (info.batteryStatus !== 'charging') device.statusLowBattery = info.batteryStatus !== 'full';

        device.polling = { nextExpectedWakeup: info.nextExpectedWakeup, pollInterval: info.pollInterval };
        params.devices.push(device);
      });
      callback(null, params);

      ring.setAlarmCallback(station, 'DataUpdate', (err, station, message) => {
        const body = message.body && message.body[0]
            , info = body && body.general && body.general.v2
            , context = body && body.context && body.context.v1 && body.context.v1.device && body.context.v1.device.v1
            , update = {};

        console.log('DataUpdate: errP=' + (!!err) + ' station=' + station.location_id + ' datatype=' + message.datatype);
        if (err) oops(err.toString());

        if (message.datatype === 'HubDisconnectionEventType') {
          console.log(JSON.stringify({ info, context, update: { statusActive: false } }, null, 2));
        }

        if (!(info && context && (message.datatype === 'DeviceInfoDocType'))) {
          return console.log('message=' + JSON.stringify(message, null, 2));
        }

        if (info.deviceType === 'hub.redsky') {
          console.log(JSON.stringify({ info, context, update: { deviceId: station.location_id, statusActive: true } }, null, 2));
        }

        if (!((info.deviceType === 'sensor.contact') || (info.deviceType === 'sensor.motion'))) {
          return console.log('deviceType=' + info.deviceType + ' ' + JSON.stringify({ info, context }, null, 2));
        }

        update.deviceId = info.zid;

        info.lastCommTime = new Date(info.lastCommTime).getTime();
        if (!isNaN(info.lastCommTime)) {
          // set device.polling.nextExpectedWakeup = info.lastCommTime + device.polling.pollInterval
        }

        if (info.deviceType === 'sensor.contact') update.contactSensorState = context.faulted ? 'NOT_DETECTED' : 'DETECTED';
        else if (info.deviceType === 'sensor.motion') update.motionDetected = context.faulted;

        if (info.tamperStatus) update.statusTampered = (info.tamperStatus === 'ok') ? 'NOT_TAMPERED' : 'TAMPERED';

        console.log(JSON.stringify({ info, context, update }, null, 2));
      });
    });
  };

  stations.forEach((station) => {
    fetch(station, (err, data) => {
      console.log(JSON.stringify(data, null, 2));
    });
  });
});
