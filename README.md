Ring.com Alarm API
=====================
This package is based on Dav Glass' [doorbot](https://github.com/davglass/doorbot) package.
However, instead of dealing with Ring's excellent line of video doorbells and spotlights,
this package deals with Ring's alarm station.

Installation
------------

    npm install ring-alarm


Usage
-----

    const ring = RingAPI({
      email: 'user@example.com'
      password: 'secret'
    });

    // get list of stations associated with the account
    ring.stations((err, stations) => {
      if (err) ...;
      
      stations.forEach((station) => {
        // get devices associated with each station
        ring.getAlarmDevices(station, (err, station, message) => {
          if (err) ...;

          message.body.forEach((device) => {
          // get properties associated with each device

            ...
          });
        });

        // register for DataUpdate messages
        ring.setAlarmCallback(station, 'DataUpdate', (err, station, message) => {
          if (err) ...;

          ...
        });

        // set alarm mode
        //   panelId: `zid` property of security-panel device
        //   mode: 'all', 'some', 'none'
        //   bypassSensorIs: an array of `zid` properties of sensor.* devices
        ring.setAlarmMode(station, panelId, mode, bypassSensorIds, (err, station, message) => {
          if (err) ...;

          ...
        });

        // done getting information about station
        ring.closeAlarmCollection(station);
      });
    });

# Many Thanks
Many thanks to [davglass](https://github.com/davglass) author of
[doorbot](https://github.com/davglass/doorbot).

Many thanks (also) to [joeyberkovitz ](https://github.com/joeyberkovitz) who submitted a
[PR](https://github.com/davglass/doorbot/pull/27) to the doorbot repository.
