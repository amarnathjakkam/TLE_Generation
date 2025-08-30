import org.orekit.data.DirectoryCrawler;
import org.orekit.data.DataContext;
import org.orekit.frames.Frame;
import org.orekit.frames.FramesFactory;
import org.orekit.models.earth.ReferenceEllipsoid;
import org.orekit.propagation.analytical.tle.TLE;
import org.orekit.propagation.analytical.tle.TLEPropagator;
import org.orekit.time.*;
import org.orekit.utils.IERSConventions;
import org.orekit.utils.PVCoordinates;
import org.orekit.frames.TopocentricFrame;
import org.orekit.bodies.GeodeticPoint;

import java.io.*;
import java.text.DecimalFormat;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Properties;

public class TLE_Generation {

    private static double pressureMbarExpFromAltKm(double hKm, double p0Mbar) {
        final double Hkm = 8.5;
        return p0Mbar * Math.exp(-hKm / Hkm);
    }

    private static double pressureMbarBarometric(double hMeters, double p0Mbar) {
        final double T0 = 288.15;
        final double L  = 0.0065;
        final double g  = 9.80665;
        final double M  = 0.0289644;
        final double R  = 8.3144598;
        return p0Mbar * Math.pow(1.0 - (L * hMeters) / T0, (g * M) / (R * L));
    }

    private static double refractBennettDeg(double altitudeDeg, double tempC, double pressureMbar) {
        if (altitudeDeg <= -1.0) return altitudeDeg;
        double altRad = Math.toRadians(altitudeDeg);
        double R_arcmin = (pressureMbar / 1010.0) * (283.0 / (273.0 + tempC))
                * (1.02 / Math.tan(altRad + Math.toRadians(10.3 / (altitudeDeg + 5.11))));
        return altitudeDeg + R_arcmin / 60.0;
    }

    private static double[] applyTilt(double azDeg, double elDeg, double tiltDeg, double tiltAzDeg) {
        double az = Math.toRadians(azDeg);
        double el = Math.toRadians(elDeg);

        double xE = Math.cos(el) * Math.sin(az);
        double yN = Math.cos(el) * Math.cos(az);
        double zU = Math.sin(el);

        double tAz = Math.toRadians(tiltAzDeg);
        double ax = Math.sin(tAz);
        double ay = Math.cos(tAz);
        double azAxis = 0.0;

        double theta = Math.toRadians(tiltDeg);

        double kDotV = ax * xE + ay * yN + azAxis * zU;
        double kxVx = ay * zU - azAxis * yN;
        double kxVy = azAxis * xE - ax * zU;
        double kxVz = ax * yN - ay * xE;

        double xR = xE * Math.cos(theta) + kxVx * Math.sin(theta) + ax * kDotV * (1.0 - Math.cos(theta));
        double yR = yN * Math.cos(theta) + kxVy * Math.sin(theta) + ay * kDotV * (1.0 - Math.cos(theta));
        double zR = zU * Math.cos(theta) + kxVz * Math.sin(theta) + azAxis * kDotV * (1.0 - Math.cos(theta));

        double elTiltDeg = Math.toDegrees(Math.asin(zR));
        double azTiltDeg = Math.toDegrees(Math.atan2(xR, yR));
        if (azTiltDeg < 0) azTiltDeg += 360.0;

        return new double[]{azTiltDeg, elTiltDeg};
    }

    public static void main(String[] args) throws Exception {
        // ----------------------------
        // Load config
        // ----------------------------
        Properties config = new Properties();
        try (InputStream input = new FileInputStream("config.txt")) {
            config.load(input);
        }

        String tleName   = config.getProperty("TLE_NAME");
        String tleLine1  = config.getProperty("TLE_LINE1");
        String tleLine2  = config.getProperty("TLE_LINE2");
        double siteLat   = Double.parseDouble(config.getProperty("SITE_LAT"));
        double siteLon   = Double.parseDouble(config.getProperty("SITE_LON"));
        double siteAltM  = Double.parseDouble(config.getProperty("SITE_HEIGHT"));
        int resolutionMs = Integer.parseInt(config.getProperty("TLE_TIME_RESOLUTION"));
        boolean applyRefraction = "1".equals(config.getProperty("ATMOSPHERIC_CORRECTION"));
        String outputFile = config.getProperty("OUTPUT_FILENAME");
        int decimals = Integer.parseInt(config.getProperty("DECIMAL_COUNT"));

        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
        TimeScale utc = TimeScalesFactory.getUTC();
        AbsoluteDate start = new AbsoluteDate(sdf.parse(config.getProperty("START_TIME")), utc);
        AbsoluteDate end   = new AbsoluteDate(sdf.parse(config.getProperty("END_TIME")), utc);

        // ----------------------------
        // Orekit setup
        // ----------------------------
        File orekitData = new File("orekit-data");
        DataContext.getDefault().getDataProvidersManager().addProvider(new DirectoryCrawler(orekitData));

        TLE tle = new TLE(tleLine1, tleLine2);
        TLEPropagator propagator = TLEPropagator.selectExtrapolator(tle);

        Frame itrf = FramesFactory.getITRF(IERSConventions.IERS_2010, true);
        ReferenceEllipsoid earth = ReferenceEllipsoid.getWgs84(itrf);
        GeodeticPoint gp = new GeodeticPoint(Math.toRadians(siteLat), Math.toRadians(siteLon), siteAltM);
        TopocentricFrame observer = new TopocentricFrame(earth, gp, "Observer");

        double pressureMbar = pressureMbarBarometric(siteAltM, 1013.25);

        DecimalFormat azFmt = new DecimalFormat("000." + "0".repeat(decimals));
        DecimalFormat elFmt = new DecimalFormat("00."  + "0".repeat(decimals));

        try (PrintWriter out = new PrintWriter(new FileWriter(outputFile))) {
            for (AbsoluteDate t = start; t.compareTo(end) <= 0; t = t.shiftedBy(resolutionMs / 1000.0)) {
                PVCoordinates pv = propagator.getPVCoordinates(t, itrf);
                double azDeg = Math.toDegrees(observer.getAzimuth(pv.getPosition(), itrf, t));
                if (azDeg < 0) azDeg += 360.0;
                double elDeg = Math.toDegrees(observer.getElevation(pv.getPosition(), itrf, t));

                if (applyRefraction) {
                    elDeg = refractBennettDeg(elDeg, 15.0, pressureMbar);
                }

                // format output: Time, Az, El
                TimeComponents tc = t.getComponents(utc).getTime();
                String line = String.format("%02d:%02d:%06.3f,%s,%s",
                        tc.getHour(), tc.getMinute(), tc.getSecond(),
                        azFmt.format(azDeg), elFmt.format(elDeg));
                out.println(line);
            }
        }

        System.out.println("✅ Done! Results written to " + outputFile);
    }
}
