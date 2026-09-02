StarGaze

An offline planetarium that tells you what you're looking at when you point your phone at the night sky.

Try StarGaze →

<p align="center"> <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/cover.png" alt="StarGaze" width="100%"> </p>

StarGaze calculates the positions of stars, planets, constellations, and the Moon using your location, the current time, and your phone's orientation. Everything runs locally, so it still works without a connection.

<p align="center"> <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/phone-sky.png" alt="StarGaze sky view" width="300"> <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/phone-tonight.png" alt="StarGaze Tonight view" width="300"> </p> <p align="center"> <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/tablet-sky.png" alt="StarGaze on tablet" width="640"> </p>
What you get
	
Stars	1,009 stars down to magnitude 4.5
Constellations	All 88
Planets	Mercury, Venus, Mars, Jupiter, Saturn
Moon	Position and current phase
Camera	Optional AR-style sky overlay
Search	Find objects by name
Tonight	See what's currently worth looking for
Sensors	Compass calibration and interference detection
Offline	Astronomy data is bundled with the app
Why I built it

I wanted a simple answer to the question:

"What am I looking at?"

I initially thought about recognising stars from the camera. After looking into it, I decided against that approach. A phone camera doesn't give you much useful information from a dark sky, especially with light pollution.

So instead of trying to recognise the sky, I calculate it.

StarGaze takes three main inputs:

Location - where the observer is
Time - when the observation is happening
Orientation - which direction the phone is pointing

The astronomy code uses those values to calculate the position of objects in the sky. Those positions are converted to altitude and azimuth and passed to the renderer.

That approach also has a useful side effect: the app doesn't need to send your location or camera images to a server.

The interesting part

The astronomy calculations live in packages/core, separately from the UI.

Stars come from a bundled catalogue. Planets and the Moon are calculated from astronomical data instead of using a fixed list of positions.

I wanted to make sure the calculations were actually correct, so I compared them against NASA JPL Horizons across several dates between 2021 and 2045.

Here are the current results:

Object	Maximum error
Sun	13.5 arcsec
Mercury	21.7 arcsec
Venus	18.0 arcsec
Mars	31.7 arcsec
Moon	16.5 arcsec
Jupiter	368.3 arcsec
Saturn	435.0 arcsec

The full Moon is about 1,800 arcseconds across.

The calculations aren't usually the problem in real-world use. The phone compass is. A phone can easily be 5-15 degrees off, especially around metal or electronics.

Getting the compass right

This was one of the parts that required the most practical testing.

The phone's magnetic heading isn't always reliable. StarGaze lets you point at a star you already know and use it as a reference to correct the heading.

It also checks for magnetic interference. If the sensor readings don't look trustworthy, the app warns you instead of giving you a confidently wrong sky.

What I intentionally don't show

Uranus and Neptune are calculated and tested, but I don't draw them in the normal sky view.

They're too faint to be useful for a normal naked-eye observation. I would rather leave them out than put a label over empty-looking sky and make the app feel inaccurate.

The same idea applies to objects that are technically above the horizon but aren't realistically visible because of daylight or a bright Moon. Those are dimmed rather than silently disappearing.

Offline

There is no backend for the astronomy calculations.

The star catalogue is bundled with the application and is about 57 KB compressed. The data isn't downloaded when the app is running.

Location data stays on the device as well.

I wanted this because a good place for stargazing isn't necessarily a place with good internet.

Run it locally
npm install
npm test
npm run dev


Then open:

http://localhost:5173


The test suite currently has 118 passing tests.

Test on a phone

Mobile browsers require HTTPS before they allow camera, location, and motion sensor access.

npm run serve


Open the HTTPS address printed by the server on your phone.

The local certificate isn't publicly trusted, so the browser will show a warning the first time. That's expected.

Android

The Android app uses the same web application.

npm run android:sync
npm run android:open


JDK 21 is required. Newer versions can cause Gradle errors such as Unsupported class file major version.

The debug APK is generated at:

android/app/build/outputs/apk/debug/app-debug.apk

Project layout
tools/                 Data preparation scripts

packages/
├── core/              Astronomy calculations + tests
└── web/               StarGaze web application

server/                HTTPS development server
android/               Android wrapper


Keeping core separate from the UI means the astronomy code can be tested independently of the browser and phone sensors.

Data

The datasets are prepared by tools/ and bundled into the app. None of these sources are contacted while StarGaze is running.

Data	Source
Stars	HYG Database v4.0
Constellation figures	Stellarium modern_iau
Planetary elements	NASA JPL SSD
Magnetic declination	IGRF-14 / NOAA NCEI
Test reference positions	NASA JPL Horizons

The HYG and Stellarium datasets are licensed under CC BY-SA 4.0. JPL's approximate planetary elements are public domain. See the respective sources for their terms.

AI usage

I used AI-assisted coding tools during development for implementation help, debugging, and keeping context across the codebase.

The project architecture, astronomy research, implementation decisions, sensor work, rendering, testing, and validation were done as part of my development work. I also checked the astronomy results against JPL reference data rather than relying on generated output without testing it.

License

MIT. See LICENSE.

The bundled datasets retain their own licenses.
