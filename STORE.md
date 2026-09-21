# Play Store listing

Everything in this file is copy and declarations for the Play Console
listing. Nothing here is fabricated or assumed — permission text matches
`AndroidManifest.xml`; the accuracy and privacy claims match what the code
and `README.md` actually do, verified in this repository, not asserted from
memory.

## Title

StarGaze

## Short description (max 80 characters)

```
Point your phone at the sky and see what you're looking at. Works offline.
```
(74 characters)

## Full description

```
Point your phone at the night sky and StarGaze tells you what you're looking
at — stars, planets, the Moon, and the constellation they belong to.

No image recognition. StarGaze doesn't photograph the sky and guess — it
calculates it, from three things: your location, the exact time, and which
way you're pointing. That's genuinely all positional astronomy needs.

• Nearly 9,000 stars, down to magnitude 6.5 — the naked-eye limit under a
  genuinely dark sky — with all 88 constellation figures drawn complete. A
  magnitude slider pulls that back to what a town actually shows.
• Every planet from Mercury to Neptune, the four brightest asteroids, and
  the Moon with its current phase and illumination.
• Meteor shower radiants while a shower is running, with its peak date and
  hourly rate.
• A live camera view behind the overlay, so you can match the markers to
  the real sky — entirely optional, and the app works without it in a
  drag-to-look-around mode.
• Works completely offline. The star catalogue, constellation figures,
  planetary data and magnetic declination model are all built into the app;
  nothing is downloaded or streamed after install.
• Nothing is transmitted anywhere. Every calculation — your position, the
  time, which way you're facing — happens on the device and stays there.
  There's no account, no backend, no analytics.
• Built-in compass calibration. Phone magnetometers are typically off by
  5-15°; sight a known bright star or planet once and StarGaze corrects for
  it.

StarGaze is for anyone who has looked up and wondered what that bright
object actually is — no astronomy background required, no signal required,
nothing sent anywhere.
```

## Permission justifications

Play Console's sensitive-permissions declaration form asks for a specific
explanation per permission. Exact text to use:

### Location (`ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`)

```
StarGaze uses the device's location (latitude and longitude only) to
calculate which stars, planets and constellations are above the horizon at
the user's position -- this is a core, unavoidable input to the app's
positional astronomy, not an incidental use. Location is read on-device,
used only for this calculation, and never transmitted anywhere: the app has
no backend and no analytics of any kind. A user who declines location
access can enter coordinates manually instead and the app remains fully
functional.
```

### Camera (`CAMERA`)

```
StarGaze optionally uses the rear camera to show a live video feed behind
the on-screen star overlay, so the user can visually line up the overlay
with the real night sky. No image or video is captured, stored, analyzed,
or transmitted -- the feed is displayed live only and never leaves the
device, and no image recognition of any kind is performed on it. The app is
fully usable without camera access, via a drag-to-look-around mode; on a
device whose primary input is a mouse or trackpad, the camera is never
requested at all, since a laptop's camera faces the user, not the sky.
```

### Internet (`INTERNET`)

Declared because the Capacitor WebView runtime that the app is built on
requires it to function, not because the app makes network requests. Stated
plainly in the Data Safety section below rather than left unexplained.

## Data Safety declaration

Play distinguishes **accesses** (reads on-device) from **collects**
(transmitted off the device). StarGaze accesses location and, optionally,
the camera; it collects and transmits neither, or anything else.

| Data type | Collected? | Shared with third parties? | Notes |
|---|---|---|---|
| Approximate location | No | No | Accessed on-device for the sky calculation; never leaves the device. |
| Precise location | No | No | Same. |
| Photos / videos (camera) | No | No | Camera feed is displayed live only, never captured or stored. |
| Any other data type | No | No | No accounts, no analytics, no crash reporting, no ads. |

Data is not encrypted in transit because none is transmitted. There is no
account creation, so there is no user data to request deletion of; nothing
is retained beyond the current app session (compass calibration and display
settings are stored locally on-device via browser storage, and can be
cleared like any other app's local data).

The `INTERNET` permission is declared (required by the underlying Capacitor
WebView runtime) but unused by the app's own logic — worth stating in the
declaration notes so it isn't mistaken for undisclosed network activity.

## Content rating

Expected answers for the content rating questionnaire: no violence, no
mature/sexual content, no gambling, no user-generated content, no in-app
purchases, no ads, no location sharing with other users (single-user,
on-device only). This should land in the lowest available rating tier in
every region's system (e.g. PEGI 3 / ESRB Everyone), but the questionnaire
itself has to be completed in Play Console by the account holder.

## Screenshots

Generated from the running app (`packages/web`) via a headless Chrome
capture at each required size — see `store/screenshots/`:

- `phone/` — 1080x1920
- `tablet-7in/` — 1200x1920
- `tablet-10in/` — 1600x2560

Each set: the sky view with the compass/readouts HUD, and the Tonight list.

## Privacy policy URL

Play requires a resolvable privacy policy URL for any app requesting camera
or location. Paste this into the Play Console listing:

```
https://ramskandh-thirandasu.github.io/stargaze/privacy.html
```

It is a static page in the web build (`packages/web/public/privacy.html`), so
it redeploys with the app and cannot drift out of step with what the code
actually does.

## Live web build

The same bundle the Android app wraps, running in a browser:

```
https://ramskandh-thirandasu.github.io/stargaze/
```

## What only the account holder can do

This file and the icon/screenshot work in this repository get the listing
content ready. The following need a human with the Play Console account and
cannot be done from here:

- A Google Play Developer account (one-time registration fee).
- Completing the content rating questionnaire in Play Console.
- Completing the Data Safety form in Play Console (this file gives the
  exact answers, but the form itself has to be filled in there).
- Uploading the signed `.aab` and submitting for review.
