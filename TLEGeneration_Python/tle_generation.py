from skyfield.api import load, wgs84, EarthSatellite
from datetime import datetime, timedelta
import numpy as np
import csv
import math

# ----------------------------
# Input data
# ----------------------------
tle_lines = [
    "1 44078U 19072A   25237.00127315  .00000014  00000-0  40313-4 0  1239",
    "2 44078  98.2808 291.9629 0018719  34.1424  38.1671 14.43768520337337"
]

siteLat = 17.269079     # degrees
siteLon = 78.495696     # degrees
siteHeight = 0 #0.610      # km

start_time = datetime(2025, 8, 25, 3, 39, 25)  # UTC
end_time   = datetime(2025, 8, 25, 3, 54, 0)   # UTC

# Tilt config (kept, but not printed; you can wire it in if needed)
tilt_deg = 0
tilt_azimuth_deg = 0   # 90° = east

# ----------------------------
# Atmospheric refraction setup
# ----------------------------
APPLY_ATMOSPHERIC_REFRACTION = True
temperature_C = 20.0  # adjust to your met data

def pressure_mbar_from_alt_km(h_km: float, p0_mbar: float = 1013.25) -> float:
    H_km = 8.5  # simple scale height model
    return p0_mbar * math.exp(-h_km / H_km)

pressure_mbar = pressure_mbar_from_alt_km(siteHeight)

# ----------------------------
# Setup Skyfield
# ----------------------------
ts = load.timescale()
sat = EarthSatellite(tle_lines[0], tle_lines[1], "TargetSat", ts)
observer = wgs84.latlon(siteLat, siteLon, siteHeight * 1000)  # meters

# ----------------------------
# Helpers
# ----------------------------
def apply_tilt(az_deg, el_deg, tilt_deg, tilt_azimuth_deg):
    az_rad = np.deg2rad(az_deg); el_rad = np.deg2rad(el_deg)
    x = np.cos(el_rad) * np.sin(az_rad)   # East
    y = np.cos(el_rad) * np.cos(az_rad)   # North
    z = np.sin(el_rad)                    # Up
    vec = np.array([x, y, z])
    tilt_az_rad = np.deg2rad(tilt_azimuth_deg)
    axis = np.array([np.sin(tilt_az_rad), np.cos(tilt_az_rad), 0.0])
    theta = np.deg2rad(tilt_deg)
    vec_tilted = (vec * np.cos(theta) +
                  np.cross(axis, vec) * np.sin(theta) +
                  axis * np.dot(axis, vec) * (1 - np.cos(theta)))
    el_tilted = np.arcsin(vec_tilted[2])
    az_tilted = np.arctan2(vec_tilted[0], vec_tilted[1])
    return (np.degrees(az_tilted) % 360.0, np.degrees(el_tilted))

def format_line(dt: datetime, az_deg: float, el_deg: float) -> str:
    """HH mm ss.zzz XXX.XX XX.XX with zero padding on az/el."""
    # time (UTC) with milliseconds
    hh = f"{dt.hour:02d}"
    mm = f"{dt.minute:02d}"
    # If dt has microseconds, reflect them; else .000
    ss = f"{dt.second:02d}"
    zzz = f"{dt.microsecond // 1000:03d}"
    # az: 3 digits before decimal, 2 decimals, zero-padded (000.00–359.99)
    az_str = f"{az_deg:06.2f}"   # width=6 includes 3 digits + '.' + 2 decimals, zero-padded
    # el: 2 digits before decimal, 2 decimals, zero-padded (can be negative)
    # width=5 (two digits + '.' + two decimals). Negative values will show a '-' and expand as needed.
    el_str = f"{el_deg:05.2f}" if el_deg >= 0 else f"{el_deg:0.2f}"
    return f"{hh} {mm} {ss}.{zzz} {az_str} {el_str}"

# ----------------------------
# Generate + write
# ----------------------------
with open("output.txt", "w", newline="") as f:
    for cur_time in (start_time + timedelta(seconds=s)
                     for s in range(int((end_time - start_time).total_milliseconds()) + 1)):
        t = ts.utc(cur_time.year, cur_time.month, cur_time.day,
                   cur_time.hour, cur_time.minute, cur_time.second)

        if APPLY_ATMOSPHERIC_REFRACTION:
            alt_app, az_app, _ = (sat - observer).at(t).altaz(
                temperature_C=temperature_C,
                pressure_mbar=pressure_mbar
            )
        else:
            alt_app, az_app, _ = (sat - observer).at(t).altaz()

        # If you want to apply tilt to the apparent pointing, uncomment:
        # az_tilted_deg, el_tilted_deg = apply_tilt(az_app.degrees, alt_app.degrees, tilt_deg, tilt_azimuth_deg)
        # line = format_line(cur_time, az_tilted_deg, el_tilted_deg)

        line = format_line(cur_time, az_app.degrees, alt_app.degrees)
        f.write(line + "\n")

print("✅ Done! Results saved to output.txt")
