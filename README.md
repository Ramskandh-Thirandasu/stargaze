StarGaze

A small offline planetarium for your phone. Point your phone at the sky and StarGaze shows you what you're looking at.

<p align="center"> <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/cover.png" alt="StarGaze" width="100%"> </p>

Try StarGaze

StarGaze runs in a browser, can be installed like an app, and doesn't need an internet connection while you're using it.

<p align="center"> <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/phone-sky.png" alt="StarGaze sky view" width="300"> <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/phone-tonight.png" alt="StarGaze Tonight view" width="300"> </p> <p align="center"> <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/tablet-sky.png" alt="StarGaze running on a tablet" width="640"> </p>
Features
1,009 stars and all 88 constellations
Mercury, Venus, Mars, Jupiter, Saturn, and the Moon
Optional camera view with labels over the real sky
Search for objects by name
A Tonight list for objects currently worth looking for
Compass calibration for inaccurate phone sensors
Magnetic interference warnings
Drag mode for using the app without phone sensors
Works offline
How it works

I originally considered using the camera to recognise stars. That turned out not to be a good approach for this project. A phone camera usually doesn't get much useful information from a dark sky, especially with light pollution.

Instead, StarGaze calculates where objects should be.

The main inputs are:

Input	Used for
Location	Determines which part of the sky is above the horizon
Time	Accounts for the movement of the sky
Phone orientation	Determines which direction the user is looking

The astronomy code calculates the positions of the objects and converts them into altitude and azimuth. The web app then uses those coordinates to draw them in the right place.

The calculations happen on the device. There isn't a server involved, and the user's location isn't uploaded anywhere.

Astronomy

The astronomy code is in packages/core and is separate from the web UI.

Stars come from a catalogue containing their positions, magnitudes, colours, and names. Planet and Moon positions are calculated from astronomical data rather than using a fixed list of positions.

I test the calculated positions against NASA JPL Horizons at several dates between 2021 and 2045.

The current position errors from those tests are:

Object	Error
Sun	13.5 arcsec
Mercury	21.7 arcsec
Venus	18.0 arcsec
Mars	31.7 arcsec
Moon	16.5 arcsec
Jupiter	368.3 arcsec
Saturn	435.0 arcsec

For comparison, the full Moon is about 1,800 arcseconds across.

In practice, the phone compass is a much bigger source of error. A phone heading can be off by 5-15 degrees, especially around metal or electronics.

Compass calibration

This was one of the less straightforward parts of the project.

Phone compasses aren't always accurate, and nearby metal or electronics can make the readings even worse.

StarGaze has a calibration mode where you can point at a star you already know. The app compares the expected direction with the phone's direction and uses the difference to correct the view.

It also checks for magnetic interference. If the sensor readings look unreliable, the app shows a warning instead of silently using them.

Visibility

The app is intended to show things that someone could realistically see.

There are 1,009 stars in the catalogue, using a magnitude limit of 4.5, and all 88 constellations are included.

Uranus and Neptune are calculated and tested but aren't displayed in the normal sky view. They're too faint to be useful for a normal naked-eye view.

Objects can also be above the horizon but not actually visible because of daylight or a bright Moon. Instead of completely hiding them, StarGaze dims them so the user can still see that they're there.

Offline

The astronomy data is bundled with the application and isn't downloaded while the app is running.

The compressed star catalogue is about 57 KB.

The location used for the calculations also stays on the device.

I wanted this to work without relying on a network connection because stargazing often happens away from places with good signal.

Running locally

You'll need Node.js and npm.

npm install
npm test
npm run dev


Then open http://localhost:5173.

The current test suite has 118 passing tests.

<details> <summary>Testing on a phone</summary>

Camera, location, and motion sensors require HTTPS in mobile browsers.

For local phone testing:

npm run serve


The server prints an HTTPS address that you can open from your phone.

The local certificate isn't from a public certificate authority, so the browser will show a certificate warning the first time. That's expected for the development server.

</details> <details> <summary>Building the Android app</summary>

The Android version uses the same web application.

npm run android:sync
npm run android:open


The Android build currently requires JDK 21.

Using a newer JDK can cause Gradle errors such as:

Unsupported class file major version


The debug APK is generated at:

android/app/build/outputs/apk/debug/app-debug.apk

</details>
Project structure
tools/       Scripts used to prepare the astronomy data

packages/
  core/      Astronomy calculations and tests
  web/       Main web application

server/      HTTPS development server

android/     Android wrapper


The astronomy code is kept separate from the UI so that most of it can be tested without needing a browser or phone.

Data sources

The datasets are prepared by the scripts in tools/ and bundled with the application. They aren't contacted while StarGaze is running.

Data	Source	License
Star positions, magnitudes, colours, names	HYG Database v4.0 — David Nash / astronexus	CC BY-SA 4.0
Constellation figures	Stellarium modern_iau sky culture	CC BY-SA 4.0
Planetary elements	NASA JPL SSD, Approximate Positions of the Planets	Public domain
Magnetic declination	IGRF-14 via NOAA NCEI	Free use

Reference positions used for testing come from NASA JPL Horizons.

AI usage

I used AI-assisted coding tools during development to help with implementation, debugging, and keeping context across the codebase.

I made the architecture and implementation decisions, researched the astronomy, worked on the sensor and rendering systems, and tested and validated the results. The astronomy calculations were also checked against external reference data rather than being accepted without testing.

License

MIT. See LICENSE.

The bundled datasets have their own licenses, listed in the data sources section.
