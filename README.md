StarGaze

A small offline planetarium for your phone. Point your phone at the sky and StarGaze shows you what you're looking at.

<p align="center"> <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/cover.png" alt="StarGaze" width="100%"> </p>

Try StarGaze

It runs in a browser, can be installed like an app, and works without an internet connection.

<p align="center"> <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/phone-sky.png" alt="StarGaze sky view showing constellations and object information" width="300"> <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/phone-tonight.png" alt="StarGaze Tonight view showing objects currently visible" width="300"> </p> <p align="center"> <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/tablet-sky.png" alt="StarGaze running on a tablet" width="640"> </p>
What it does
Shows 1,009 stars and all 88 constellations.
Shows Mercury, Venus, Mars, Jupiter, Saturn, and the Moon.
Uses your location, time, and phone orientation to calculate what is in the sky.
Has an optional camera mode with labels over the real sky.
Works offline. The star data is bundled with the app.
Includes compass calibration for phones with inaccurate sensors.
Warns when magnetic interference is affecting the compass.
Lets you search for objects by name.
Has a "Tonight" list showing things that are currently visible.
Has a drag mode for using the app without phone sensors.
Why I made it

I wanted to make something that could answer a simple question while looking at the night sky:

What is that?

There are already a lot of astronomy apps that do this, but I wanted to understand how one actually works instead of relying on an existing astronomy service.

I initially looked at whether the app could identify stars from the camera. That didn't make much sense for this project. A normal phone camera doesn't get much useful information from a dark sky, especially with light pollution.

Instead, StarGaze calculates where objects should be.

The main inputs are:

Your location
The current time
The direction your phone is pointing

The astronomy code uses those values to calculate where objects should appear in the sky. The result is then converted into coordinates that the UI can draw.

This also means the app doesn't need to upload a photo or your location to a server. The calculations happen on the device.

How the sky calculation works

The astronomy code is separate from the UI in packages/core.

For stars, StarGaze uses catalogue data containing their positions, magnitudes, colours, and names. The positions are converted through the required coordinate systems and adjusted for the observer's location and time.

For planets and the Moon, their positions are calculated from astronomical data rather than being stored as a fixed list of positions.

After calculating an object's position, it is converted to altitude and azimuth. The sky view uses those values to figure out where the object should be drawn.

The phone's sensors provide the direction the user is looking.

Keeping the astronomy code separate from the UI also makes it easier to test the calculations without needing a browser or phone.

Compass calibration

The astronomy calculations can be very accurate, but phone compasses are not.

A phone can easily be several degrees off. Metal objects, speakers, cars, and other electronics can also affect the magnetic sensor.

StarGaze has a calibration mode where you can point at a star you already know and use it as a reference. The app can then correct the phone's orientation.

There is also an interference check. If the magnetic sensor looks unreliable, StarGaze shows a warning instead of silently using a bad heading.

Things I left out on purpose

I don't show Uranus and Neptune in the normal sky view.

The app can calculate their positions and they are included in testing, but they are too faint to be useful for a normal naked-eye sky view. Showing a label for something you can't actually see would make the app less useful.

The same idea applies to objects that are technically above the horizon but aren't realistically visible because of daylight or a bright Moon.

Instead of completely hiding them, StarGaze dims them and indicates that they aren't currently visible.

Offline

StarGaze doesn't make requests to a server while you are using it.

The star catalogue is bundled with the application. The compressed catalogue is about 57 KB.

This was important to me because stargazing often happens away from places with a good internet connection.

Your location also stays on the device.

Accuracy

I tested the calculated positions against NASA JPL Horizons at several dates between 2021 and 2045.

The differences are measured in arcseconds. For reference, the full Moon is about 1,800 arcseconds across.

Object	Error
Sun	13.5"
Mercury	21.7"
Venus	18.0"
Mars	31.7"
Moon	16.5"
Jupiter	368.3"
Saturn	435.0"

Uranus and Neptune are also calculated and tested, but aren't displayed in the normal sky view.

In actual use, the phone's compass is a much bigger source of error than the astronomy calculations. A phone compass can be off by 5-15 degrees, which is much larger than the errors in the calculated positions.

Running locally

You'll need Node.js and npm.

npm install
npm test
npm run dev


Then open:

http://localhost:5173


The test suite currently has 118 passing tests.

Testing on a phone

Phone browsers require HTTPS for camera, location, and motion sensor access.

For local testing, run:

npm run serve


The server prints an HTTPS address that you can open from your phone.

Your browser may show a certificate warning because the local certificate isn't from a public certificate authority. That's expected for the development server.

Android

The Android version uses the same web app.

npm run android:sync
npm run android:open


The Android build currently requires JDK 21. Using a newer JDK can cause Gradle errors such as Unsupported class file major version.

The debug APK is generated at:

android/app/build/outputs/apk/debug/app-debug.apk

Project structure
tools/
  Scripts used to prepare the astronomy data.

packages/
  core/
    Astronomy calculations and tests.

  web/
    The main StarGaze web app.

server/
  HTTPS development server for testing on a phone.

android/
  Android wrapper around the web app.

Data sources

The datasets are prepared by the scripts in tools/ and bundled into the application. They aren't downloaded while the app is running.

Data	Source
Star positions, magnitudes, colours, and names	HYG Database v4.0 by David Nash / astronexus, CC BY-SA 4.0
Constellation figures	Stellarium modern_iau sky culture, CC BY-SA 4.0
Planetary elements	NASA JPL SSD, Approximate Positions of the Planets, public domain
Magnetic declination	IGRF-14, IAGA Working Group V-MOD, via NOAA NCEI

The reference positions used for the astronomy tests come from NASA JPL Horizons.

AI usage

I used AI-assisted coding tools during development.

I still made the architecture decisions, researched the astronomy, implemented the sensor and rendering systems, and tested and debugged the application. I used AI as a development tool for working through code, keeping context across the project, and helping with implementation and debugging.

I also verified the astronomy calculations against external reference data instead of treating AI-generated calculations as automatically correct.

License

MIT. See LICENSE.

The bundled datasets have their own licenses, listed above.
