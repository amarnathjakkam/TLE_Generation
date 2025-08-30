function generateAzElData(tleLine1, tleLine2, lat, lon, height, startDate, endDate, stepMs, tiltAz, tiltEl, progressCallback) {
  const satrec = satellite.twoline2satrec(tleLine1, tleLine2);
  const results = [];

  let current = new Date(startDate);
  let totalSteps = Math.ceil((endDate - startDate) / stepMs);
  let step = 0;

  while (current <= endDate) {
    const positionAndVelocity = satellite.propagate(satrec, current);
    if (positionAndVelocity.position) {
      const gmst = satellite.gstime(current);
      const positionGd = satellite.eciToGeodetic(positionAndVelocity.position, gmst);

      const observerGd = {
        longitude: satellite.degreesToRadians(lon),
        latitude: satellite.degreesToRadians(lat),
        height: height / 1000.0,
      };

      const lookAngles = satellite.ecfToLookAngles(observerGd, satellite.eciToEcf(positionAndVelocity.position, gmst));

      let az = satellite.radiansToDegrees(lookAngles.azimuth) + tiltAz;
      let el = satellite.radiansToDegrees(lookAngles.elevation) + tiltEl;

      if (az < 0) az += 360;
      if (az > 360) az -= 360;

      results.push([
        current.toISOString().replace("T"," ").replace("Z",""),
        az.toFixed(2),
        el.toFixed(2),
      ]);
    }

    current = new Date(current.getTime() + stepMs);
    step++;
    if (progressCallback) progressCallback(Math.floor((step / totalSteps) * 100));
  }
  return results;
}
