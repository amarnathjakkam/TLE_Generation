//
// main.cpp 
//
// This sample code demonstrates how to use the OrbitTools C++ classes
// to determine satellite position and look angles.
//
// Copyright (c) 2003-2014 Michael F. Henry
//
// 06/2014
//
#include "stdafx.h"

#include <stdio.h>
#include <QDateTime>
#include <QDebug>
#include <math.h>
#include <QFile>
#include <QTextStream>
#include <QDebug>
#include <QString>
#include <QDateTime>
#include <map>

// "coreLib.h" includes basic types from the core library,
// such as cSite, cJulian, etc. The header file also contains a
// "using namespace" statement for Zeptomoby::OrbitTools.
#include "coreLib.h"

// "orbitLib.h" includes basic types from the orbit library,
// including cOrbit.
#include "orbitLib.h"

// Forward declaration of helper function; see below
void PrintPosVel(const cSatellite& sat);

QDateTime convertFractionalTimestampToDateTime(uint8_t year, double fractional_date_time){
    uint16_t dayOfyear= uint16_t(fractional_date_time);
    double sample_Time= fractional_date_time - dayOfyear; //0.75767778;//85986634;
    QDateTime epoch_Time;

    epoch_Time.setDate(QDate(2000 + year, 1, 1));
    epoch_Time =epoch_Time.addDays(dayOfyear - 1);


    uint8_t hour = 0, minute = 0, sec = 0;
    uint16_t m_sec = 0;

    double hourFraction = sample_Time*24;
    hour = uint8_t(floor(hourFraction));
    double minuteFraction = (hourFraction - hour)*60;
    minute = uint8_t(floor(minuteFraction));
    double secsFraction = (minuteFraction - minute)*60;
    sec = uint8_t(floor(secsFraction));
    double msecsFraction = (secsFraction - sec)*1000;
    m_sec = uint16_t(floor(msecsFraction));

    epoch_Time.setTime(QTime(hour, minute, sec, m_sec));


    return epoch_Time;
}

QDateTime convertEpochStringToDateTime(QString epochTimeString){
    uint8_t year = epochTimeString.left(2).toUInt();
    double dateTimeString = epochTimeString.mid(2).toDouble();
    return convertFractionalTimestampToDateTime(year, dateTimeString);
}

#define TILE_LINE_LENGTH    69
bool isValidTleLine(QString line){
    bool result = false;

    if(line.length() == TILE_LINE_LENGTH){
        uint16_t checksum = line.right(1).toUInt();

        uint16_t sumOfCharacters = 0;
        for(uint8_t ix = 0; ix < line.length() - 1; ++ix){
            uint8_t byte = (uint8_t)line.toStdString().data()[ix];
            if(byte >= 0x30 && byte <= 0x39){
                sumOfCharacters += byte - 0x30;
            }else if(byte == '-'){
                ++sumOfCharacters;
            }
        }
        qDebug()<<"sumOfCharacters"<<sumOfCharacters<<"checksum"<<checksum;
        result = (sumOfCharacters % 10) == checksum;
    }

    return result;
}

//////////////////////////////////////////////////////////////////////////////
/// \brief main
/// \param argc
/// \param argv
/// \return

struct LookAngleConfiguration {
    std::string tleName;
    std::string tleLine1;
    std::string tleLine2;
    std::string outputFilename;
    double siteLat;
    double siteLon;
    double siteHeight;
    QDateTime startTime;
    QDateTime endTime;
    uint32_t timeResolutionMs;
    uint8_t decimalCount;
    bool atmosphericCorrection;
};

LookAngleConfiguration loadConfig(const QString& filename) {
    LookAngleConfiguration cfg;
    QFile file(filename);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        qFatal("Cannot open config file");
    }

    QTextStream in(&file);
    std::map<QString, QString> kv;

    while (!in.atEnd()) {
        QString line = in.readLine().trimmed();
        if (line.isEmpty() || line.startsWith("#")) continue;
        auto parts = line.split("=");
        if (parts.size() == 2) {
            kv[parts[0].trimmed()] = parts[1].trimmed();
        }
    }

    cfg.tleName = kv["TLE_NAME"].toStdString();
    cfg.tleLine1 = kv["TLE_LINE1"].toStdString();
    cfg.tleLine2 = kv["TLE_LINE2"].toStdString();
    cfg.outputFilename = kv["OUTPUT_FILENAME"].toStdString();
    cfg.siteLat = kv["SITE_LAT"].toDouble();
    cfg.siteLon = kv["SITE_LON"].toDouble();
    cfg.siteHeight = kv["SITE_HEIGHT"].toDouble();
    cfg.startTime = QDateTime::fromString(kv["START_TIME"], "yyyy-MM-dd HH:mm:ss");
//    cfg.startTime.setTimeSpec(Qt::UTC);
    cfg.endTime   = QDateTime::fromString(kv["END_TIME"], "yyyy-MM-dd HH:mm:ss");
//    cfg.endTime.setTimeSpec(Qt::UTC);
    cfg.timeResolutionMs = kv["TLE_TIME_RESOLUTION"].toUInt();
    cfg.atmosphericCorrection = (kv["ATMOSPHERIC_CORRECTION"] == "1");
    cfg.decimalCount = kv["DECIMAL_COUNT"].toUInt();
    return cfg;
}

unsigned char isAtmosphericCorrectionRequired = 1;
int main(int argc, char*  argv[] )
{
    uint64_t diffrenceInMSecsFraction = 0;
    QDateTime currentTime = QDateTime::currentDateTime();
#if(1)
    LookAngleConfiguration cfg = loadConfig("../look_angle_configuration.txt");
    uint32_t TLE_TIME_RESOLUTION = cfg.timeResolutionMs;
    string str1 = cfg.tleName;
    string str2 = cfg.tleLine1;
    string str3 = cfg.tleLine2;
    double siteLat = cfg.siteLat;
    double siteLon = cfg.siteLon;
    double siteheight = cfg.siteHeight;
    QDateTime startTime = cfg.startTime;
    QDateTime endTime = cfg.endTime;
    isAtmosphericCorrectionRequired = cfg.atmosphericCorrection;
    string outputFilename = cfg.outputFilename;
    uint8_t decimalCount = cfg.decimalCount;
#else
    // Test SGP4 TLE data
    uint32_t TLE_TIME_RESOLUTION = 1000; //in msecs
    string str1 = "D091";
    string str2 = "1 44078U 19072A   25237.00127315  .00000014  00000-0  40313-4 0  1239";
    string str3 = "2 44078  98.2808 291.9629 0018719  34.1424  38.1671 14.43768520337337";


    double siteLat = 17.268660; //17.269079; //13.0743; //13.0743; //13.0703
    double siteLon = 78.496172; //78.495696;//76.1016; //76.1016; //76.0961
    double siteheight = 0; //0.200; //0.610 //0.915409; //915.409; //899.49

//    QDateTime startTime(QDate(2025, 8, 25), QTime(3, 39, 25));
//    QDateTime endTime(QDate(2025, 8, 25), QTime(3, 54, 00));

    QDateTime startTime(QDate(2025, 8, 25), QTime( 16, 17, 11));
    QDateTime endTime(QDate(2025, 8, 25), QTime( 16, 31, 10));
    isAtmosphericCorrectionRequired = true;
#endif

    QString line1 = QString(str2.data());
    QString line2 = QString(str3.data());

   qDebug()<<"line1"<<isValidTleLine(line1)<<"line2"<<isValidTleLine(line2)<<endl
          <<startTime<<endTime;

   if(isValidTleLine(line1) && isValidTleLine(line2)){
    QString epochTimeString = line1.mid(18, 14);

    QDateTime epoch_Time = convertEpochStringToDateTime(epochTimeString);

    if(epoch_Time.msecsTo(startTime) < 0){
        startTime = epoch_Time;
    }

    diffrenceInMSecsFraction = epoch_Time.msecsTo(startTime);
    qDebug()<<"epoch_Time"<<epochTimeString<<epoch_Time<<" diffrence msecs"<<diffrenceInMSecsFraction
           <<epoch_Time.addMSecs(diffrenceInMSecsFraction);
   }else{
       qDebug()<<"Invalid Two line lements";
       return 0;
   }




    // Create a TLE object using the data above
    cTle tleSGP4(str1, str2, str3);

    // Create a satellite object from the TLE object
    cSatellite satSGP4(tleSGP4);

    // Print the position and velocity information of the satellite
//    PrintPosVel(satSGP4);

    // Create a TLE object using the data above
    cTle tleSDP4(str1, str2, str3);

    // Create a satellite object from the TLE object
    cSatellite satSDP4(tleSDP4);

    // Print the position and velocity information of the satellite
//    PrintPosVel(satSDP4);

//    printf("Example output:\n");


    // Example: Define a location on the earth, then determine the look-angle
    // to the SDP4 satellite defined above.

    // Get the location of the satellite. The earth-centered inertial (ECI)
    // information is placed into eciSDP4.
    // Here we ask for the location of the satellite 90 minutes after
    // the TLE epoch.
    QFile file(outputFilename.data());
    if (!file.open(QIODevice::WriteOnly | QIODevice::Text)) {
        qDebug() << "Could not open file for writing.";
        return -1;
    }
    QTextStream out(&file);
    out << "HH mm ss.zzz Longitude Latitude\n";

    for(uint32_t ix = 0; startTime.addMSecs(ix*TLE_TIME_RESOLUTION).msecsTo(endTime) > 0 ; ++ix){
        uint64_t currentPositionDiffrenceInMsec = diffrenceInMSecsFraction + (ix*TLE_TIME_RESOLUTION);
        double milliSecsValue = currentPositionDiffrenceInMsec % 60000;
        double diffrenceInMinsFraction = (uint64_t)(currentPositionDiffrenceInMsec - milliSecsValue)/60000.0;
        milliSecsValue = milliSecsValue/1000.0f;
        diffrenceInMinsFraction += milliSecsValue/60.0f;


        cSite siteEquator(siteLat, siteLon, siteheight); // 0.00 N, 100.00 W, 0 km altitude

        cEciTime eciSGP4 = satSGP4.PositionEci(diffrenceInMinsFraction);
        cTopo topoLook = siteEquator.GetLookAngle(eciSGP4);

//        cEciTime eciSDP4 = satSDP4.PositionEci(diffrenceInMinsFraction);
//        cTopo topoLook = siteEquator.GetLookAngle(eciSDP4);

        //if(topoLook.AzimuthDeg() > 0 && topoLook.ElevationDeg() > 0)
        {
            // Print out the results.
//            qDebug()<<"currentTime"<<startTime.addSecs(ix*TLE_TIME_RESOLUTION).toString("hh:mm:ss.zzz")
//                   <<"Az"<<QString::number(topoLook.AzimuthDeg(), 'f', 4)
//                    <<"El"<<QString::number(topoLook.ElevationDeg(), 'f', 2)
//                     <<"Speed"<<topoLook.RangeKm()<<topoLook.RangeRateKmSec()
//                    <<"minFraction"<<diffrenceInMinsFraction;
//            qDebug()<<"currentTime"<<startTime.addMSecs(ix*TLE_TIME_RESOLUTION).toString("hh mm ss")
//                   <<" Az: "<<QString::number(topoLook.AzimuthDeg(), 'f', 2)
//                    <<" El: "<<QString::number(topoLook.ElevationDeg(), 'f', 2);
        }
        QDateTime current = startTime.addMSecs(ix*TLE_TIME_RESOLUTION);
        if(topoLook.AzimuthDeg() >= 0 && topoLook.ElevationDeg() >= 0){
//            out << current.toString("yyyy-MM-dd hh:mm:ss").toStdString().c_str() << " "
//                << QString::number(topoLook.AzimuthDeg(), 'f', 4).toStdString().c_str() << " "
//                << QString::number(topoLook.ElevationDeg(), 'f', 4).toStdString().c_str()
//                << "\n";

            int hh   = current.time().hour();
            int mm   = current.time().minute();
            int ss   = current.time().second();
            int msec = current.time().msec();

            // seconds with fractional part
            double secFrac = ss + msec / 1000.0;

            // Prepare formatted output
            QString line = QString("%1 %2 %3.%4 %5 %6")
                .arg(hh, 2, 10, QChar('0'))    // HH
                .arg(mm, 2, 10, QChar('0'))    // MM
                .arg(ss, 2, 10, QChar('0'))    // SS
                .arg(msec, 3, 10, QChar('0'))    // msec ZZZ
                .arg(QString::number(topoLook.AzimuthDeg(), 'f', decimalCount).rightJustified(4+decimalCount, '0'))  // XXX.XXXX
                .arg(QString::number(topoLook.ElevationDeg(), 'f', decimalCount).rightJustified(3+decimalCount, '0')); // XX.XXXX

            out << line.toStdString().c_str() << "\n";
        }
    }

    file.close();
    qDebug()<<"Completed";
    return 0;
}

/////////////////////////////////////////////////////////////////////////////
// Helper function to output position and velocity information
void PrintPosVel(const cSatellite& sat)
{
    vector<cEci> vecPos;

    // Calculate the position and velocity of the satellite for various times.
    // mpe = "minutes past epoch"
    for (int mpe = 0; mpe <= (360 * 4); mpe += 360)
    {
        // Get the position of the satellite at time "mpe"
        cEciTime eci = sat.PositionEci(mpe);

        // Push the coordinates object onto the end of the vector.
        vecPos.push_back(eci);
    }

    // Print TLE data
    printf("%s\n",   sat.Name().c_str());
    printf("%s\n",   sat.Orbit().TleLine1().c_str());
    printf("%s\n\n", sat.Orbit().TleLine2().c_str());

    // Header
    printf("  TSINCE            X                Y                Z\n\n");

    // Iterate over each of the ECI position objects pushed onto the
    // position vector, above, printing the ECI position information
    // as we go.
    for (unsigned int i = 0; i < vecPos.size(); i++)
    {
        printf("%8d.00  %16.8f %16.8f %16.8f\n",
               i * 360,
               vecPos[i].Position().m_x,
               vecPos[i].Position().m_y,
               vecPos[i].Position().m_z);
    }

    printf("\n                    XDOT             YDOT             ZDOT\n\n");

    // Iterate over each of the ECI position objects in the position
    // vector again, but this time print the velocity information.
    for (unsigned int i = 0; i < vecPos.size(); i++)
    {
        printf("             %16.8f %16.8f %16.8f\n",
               vecPos[i].Velocity().m_x,
               vecPos[i].Velocity().m_y,
               vecPos[i].Velocity().m_z);
    }

    printf("\n");
}
