/**
 * The sky at one moment, for one observer.
 *
 * This is the slow half of the loop. Recomputing it costs about a millisecond
 * for a thousand stars, and the sky moves a quarter of a degree in that same
 * minute, so it runs on a timer rather than per frame.
 */

import {
  applyRefraction,
  apparentTerms,
  applyApparentPlace,
  applyDiurnalParallax,
  activeShowers,
  asteroidPosition,
  asteroidsValidAt,
  ASTEROIDS,
  calendarDayLabel,
  combineAngles,
  countBrighterThan,
  createHorizontalBuffer,
  deepSkyDesignation,
  deepSkyLabel,
  DEEP_SKY_TYPE_NAMES,
  equatorialToHorizontal,
  julianDate,
  limitingMagnitude,
  localSiderealTime,
  magneticDeclination,
  METEOR_MAGNITUDE,
  moonPosition,
  planetPosition,
  precessCatalog,
  precessFromJ2000,
  riseTransitSet,
  RISE_SET_ALTITUDE,
  sunPosition,
  terrestrialJulianDate,
  toHorizontal,
  VISIBLE_PLANETS,
  type HorizontalBuffer,
  type PrecessedCatalog,
  type StarCatalog,
} from '@stargaze/core';

import type { SkyData } from './data.js';
import type { Position } from './sensors.js';
import { starLabel } from './data.js';

export type ObjectKind = 'planet' | 'asteroid' | 'moon' | 'sun' | 'star' | 'deepsky' | 'shower';

export interface SkyObject {
  name: string;
  kind: ObjectKind;
  /** Right ascension of date, degrees. Needed for rise/transit/set. */
  ra: number;
  /** Declination of date, degrees. */
  dec: number;
  altitude: number;
  azimuth: number;
  magnitude: number;
  /** Degrees across. Zero for anything that is a point source in practice.
   *  For a deep-sky object this is the long axis; see `angularMinor`. */
  angularDiameter: number;
  /** Distance, in the unit named by `distanceUnit`. */
  distance: number;
  distanceUnit: 'au' | 'km';
  illumination?: number;
  phase?: number;
  /** Deep-sky only: the short axis, degrees. Nebulae and galaxies are not
   *  round, and drawing M31 as a circle would be off by a factor of three. */
  angularMinor?: number;
  /** Every catalogue number it has: "M31 · NGC 224" for a Messier object,
   *  "4 Vesta" for an asteroid. Absent for planets and the Moon. */
  designation?: string;
  /** Deep-sky only: "Galaxy", "Globular cluster", and so on. */
  objectType?: string;
  /** Meteor shower only: when it peaks, e.g. "12 Aug". */
  peak?: string;
  /** Meteor shower only: published zenithal hourly rate at the peak. */
  hourlyRate?: number;
  /** Meteor shower only: days to the peak, negative once it has passed. */
  daysToPeak?: number;
}

export interface SkyFrame {
  when: Date;
  /** Altitude of the Sun, degrees. Negative means night. */
  sunAltitude: number;
  /** Faintest magnitude the sky itself lets through right now -- see
   *  limitingMagnitude. Objects fainter than this are still drawn (this is a
   *  visibility model, not a filter) but should render de-emphasised. */
  limitingMagnitude: number;
  jd: number;
  lst: number;
  observer: Position;
  /** Degrees east; add to a magnetic bearing for a true one. */
  declination: number;
  declinationReliable: boolean;
  /** True once the device clock is past the declination model's secular-
   *  variation validity window -- still applied (extrapolating a smooth
   *  field a little past its window beats nothing), but worth saying so. */
  declinationStale: boolean;
  /** The same, for the asteroids' osculating elements -- see
   *  asteroidsValidAt. Still drawn, still labelled stale. */
  asteroidsStale: boolean;

  catalog: StarCatalog;
  stars: HorizontalBuffer;
  /** How many stars were transformed -- the rest are below the cutoff. */
  starCount: number;

  objects: SkyObject[];

  /** Resolve the index encoding used by the renderer's hit-testing. */
  positionOf(index: number): { altitude: number; azimuth: number } | null;
}

/**
 * Holds the derived state that only changes when the date or the observer does,
 * so a frame update is a transform rather than a rebuild.
 */
export class SkyModel {
  private precessed: PrecessedCatalog;
  private buffer: HorizontalBuffer;
  private precessedFor: number;

  constructor(private readonly data: SkyData) {
    this.precessed = precessCatalog(data.stars, julianDate(new Date()));
    this.precessedFor = this.precessed.jd;
    this.buffer = createHorizontalBuffer(data.stars.count);
  }

  compute(
    when: Date,
    observer: Position,
    magnitudeLimit: number,
    refract: boolean = true,
  ): SkyFrame {
    const jd = julianDate(when);
    const lst = localSiderealTime(jd, observer.longitude);

    // Precession moves stars by well under an arcsecond a day. Redoing it once
    // a month is already far more often than it can matter.
    if (Math.abs(jd - this.precessedFor) > 30) {
      this.precessed = precessCatalog(this.data.stars, jd);
      this.precessedFor = jd;
    }

    const starCount = countBrighterThan(this.data.stars, magnitudeLimit);
    toHorizontal(this.precessed, lst, observer.latitude, this.buffer, starCount, refract);

    const declination = magneticDeclination(
      this.data.declination,
      observer.latitude,
      observer.longitude,
      when,
    );

    const objects = this.computeObjects(when, jd, lst, observer, refract);
    const sunAltitude = objects.find((object) => object.kind === 'sun')?.altitude ?? -90;
    const moon = objects.find((object) => object.kind === 'moon');

    const buffer = this.buffer;
    return {
      when,
      sunAltitude,
      limitingMagnitude: limitingMagnitude(sunAltitude, moon?.altitude ?? -90, moon?.illumination ?? 0),
      jd,
      lst,
      observer,
      declination: declination.degrees,
      declinationReliable: declination.reliable,
      declinationStale: declination.stale,
      asteroidsStale: !asteroidsValidAt(this.data.asteroids, when),
      catalog: this.data.stars,
      stars: buffer,
      starCount,
      objects,
      positionOf(index: number) {
        if (index < 0) {
          const object = objects[-1 - index];
          return object ? { altitude: object.altitude, azimuth: object.azimuth } : null;
        }
        if (index >= starCount) return null;
        return {
          altitude: buffer.altitude[index] as number,
          azimuth: buffer.azimuth[index] as number,
        };
      },
    };
  }

  private computeObjects(
    when: Date,
    jd: number,
    lst: number,
    observer: Position,
    refract: boolean,
  ): SkyObject[] {
    const objects: SkyObject[] = [];

    // The Moon and planet theories are functions of Terrestrial Time; the
    // clock only gives UT. Sidereal time (lst) stays on the plain jd -- see
    // terrestrialJulianDate's doc comment.
    const ttJd = terrestrialJulianDate(jd);

    // Nutation and aberration's shared per-instant terms, computed once and
    // reused for the Moon, Sun and every planet below.
    const terms = apparentTerms(ttJd);

    // The Moon first: it is the brightest thing after the Sun and the one worth
    // aiming at to check the overlay is aligned. moonPosition already returns
    // the apparent place (nutation and aberration included) -- see moon.ts.
    const moon = moonPosition(ttJd, observer, lst);
    let moonHorizontal = equatorialToHorizontal(moon.ra, moon.dec, lst, observer.latitude);
    if (refract) moonHorizontal = applyRefraction(moonHorizontal);
    objects.push({
      name: 'Moon',
      kind: 'moon',
      ra: moon.ra,
      dec: moon.dec,
      altitude: moonHorizontal.altitude,
      azimuth: moonHorizontal.azimuth,
      // Brightness swings with phase; a new moon is not magnitude -12.7.
      magnitude: -12.7 + 5 * Math.log10(Math.max(0.02, moon.illumination)) * 0.4,
      angularDiameter: moon.angularDiameter,
      distance: moon.distance,
      distanceUnit: 'km',
      illumination: moon.illumination,
      phase: moon.phase,
    });

    const sun = sunPosition(this.data.planets, ttJd);
    // The Sun's catalogue position is J2000; the stars are precessed to date,
    // so this has to be too or the two disagree by a third of a degree.
    const sunOfDate = precessFromJ2000(sun.ra, sun.dec, jd);
    const sunApparent = applyApparentPlace(sunOfDate.ra, sunOfDate.dec, terms);
    let sunHorizontal = equatorialToHorizontal(
      sunApparent.ra,
      sunApparent.dec,
      lst,
      observer.latitude,
    );
    sunHorizontal = applyDiurnalParallax(sunHorizontal, sun.distance);
    if (refract) sunHorizontal = applyRefraction(sunHorizontal);
    objects.push({
      name: 'Sun',
      kind: 'sun',
      ra: sunApparent.ra,
      dec: sunApparent.dec,
      altitude: sunHorizontal.altitude,
      azimuth: sunHorizontal.azimuth,
      magnitude: sun.magnitude,
      angularDiameter: 0.533,
      distance: sun.distance,
      distanceUnit: 'au',
    });

    for (const name of VISIBLE_PLANETS) {
      const planet = planetPosition(this.data.planets, name, ttJd);
      const ofDate = precessFromJ2000(planet.ra, planet.dec, jd);
      const apparent = applyApparentPlace(ofDate.ra, ofDate.dec, terms);
      let horizontal = equatorialToHorizontal(apparent.ra, apparent.dec, lst, observer.latitude);
      horizontal = applyDiurnalParallax(horizontal, planet.distance);
      if (refract) horizontal = applyRefraction(horizontal);

      objects.push({
        name,
        kind: 'planet',
        ra: apparent.ra,
        dec: apparent.dec,
        altitude: horizontal.altitude,
        azimuth: horizontal.azimuth,
        magnitude: planet.magnitude,
        angularDiameter: 0,
        distance: planet.distance,
        distanceUnit: 'au',
      });
    }

    // The bright minor planets, on the same path as the planets proper: the
    // only difference is which file their elements come from and which
    // brightness law applies, both of which asteroidPosition handles.
    for (const name of ASTEROIDS) {
      const asteroid = asteroidPosition(this.data.asteroids, this.data.planets, name, ttJd);
      const ofDate = precessFromJ2000(asteroid.ra, asteroid.dec, jd);
      const apparent = applyApparentPlace(ofDate.ra, ofDate.dec, terms);
      let horizontal = equatorialToHorizontal(apparent.ra, apparent.dec, lst, observer.latitude);
      horizontal = applyDiurnalParallax(horizontal, asteroid.distance);
      if (refract) horizontal = applyRefraction(horizontal);

      objects.push({
        name,
        kind: 'asteroid',
        ra: apparent.ra,
        dec: apparent.dec,
        altitude: horizontal.altitude,
        azimuth: horizontal.azimuth,
        magnitude: asteroid.magnitude,
        angularDiameter: 0,
        distance: asteroid.distance,
        distanceUnit: 'au',
        designation: this.data.asteroids.asteroids[name]?.designation ?? name,
      });
    }

    // Deep-sky objects ride the same path as the planets rather than the star
    // catalogue's bulk transform: there are a few dozen of them, they carry
    // strings, and they need a per-object size. No proper motion and no
    // diurnal parallax -- a galaxy is far enough away that both are zero.
    for (const object of this.data.deepSky) {
      const ofDate = precessFromJ2000(object.ra, object.dec, jd);
      const apparent = applyApparentPlace(ofDate.ra, ofDate.dec, terms);
      let horizontal = equatorialToHorizontal(apparent.ra, apparent.dec, lst, observer.latitude);
      if (refract) horizontal = applyRefraction(horizontal);

      objects.push({
        name: deepSkyLabel(object),
        kind: 'deepsky',
        ra: apparent.ra,
        dec: apparent.dec,
        altitude: horizontal.altitude,
        azimuth: horizontal.azimuth,
        magnitude: object.mag,
        angularDiameter: object.major,
        angularMinor: object.minor,
        // The catalogue has no distances and the published ones disagree by
        // more than they agree, so the info card says so rather than guessing.
        distance: 0,
        distanceUnit: 'au',
        designation: deepSkyDesignation(object),
        objectType: DEEP_SKY_TYPE_NAMES[object.type],
      });
    }

    // Meteor radiants, but only while their shower is running: a marker for
    // the Perseids in February would be pointing at a patch of Perseus with
    // nothing coming out of it. Position is the radiant, not an object -- see
    // showers.ts for why it still carries a magnitude.
    for (const { shower, daysToPeak } of activeShowers(when)) {
      const ofDate = precessFromJ2000(shower.ra, shower.dec, jd);
      const apparent = applyApparentPlace(ofDate.ra, ofDate.dec, terms);
      let horizontal = equatorialToHorizontal(apparent.ra, apparent.dec, lst, observer.latitude);
      if (refract) horizontal = applyRefraction(horizontal);

      objects.push({
        name: shower.name,
        kind: 'shower',
        ra: apparent.ra,
        dec: apparent.dec,
        altitude: horizontal.altitude,
        azimuth: horizontal.azimuth,
        magnitude: METEOR_MAGNITUDE,
        // A few degrees across: a radiant is a region the tracks point back
        // to, not a spot, and drawing it as a dot would invite the user to
        // stare at one place instead of the half of the sky around it.
        angularDiameter: 6,
        distance: 0,
        distanceUnit: 'au',
        designation: shower.code,
        objectType: 'Meteor shower',
        peak: calendarDayLabel(shower.peak),
        hourlyRate: shower.zhr,
        daysToPeak,
      });
    }

    return objects;
  }
}

/**
 * The one-line summary of a shower: when it is best and roughly how many.
 *
 * "Peaks 12 Aug" rather than a countdown, because the number that matters to
 * someone standing outside is the date they should come back on.
 */
function showerDetail(object: SkyObject): string {
  const rate = `~${object.hourlyRate}/hr at peak`;
  const days = object.daysToPeak ?? 0;
  if (days === 0) return `Meteor shower · peaks tonight · ${rate}`;
  return `Meteor shower · peaks ${object.peak} · ${rate}`;
}

export interface TonightEntry {
  label: string;
  detail: string;
  magnitude: number;
  altitude: number;
  azimuth: number;
  /** The renderer's index encoding, so tapping a row can select it. */
  index: number;
  kind: ObjectKind;
  /** True when the sky itself is too bright to actually see this right now
   *  -- still listed, never hidden, per the visibility model in
   *  packages/core/src/visibility.ts. This is what "tonight" means; the
   *  user's own magnitude-limit setting is a separate, coarser cutoff. */
  washedOut: boolean;
}

/**
 * What is up right now, leading with what is actually observable.
 *
 * The Sun is excluded when it is up: "what can I see tonight" has an obvious
 * answer during the day and it is not a list. The Moon is never washed out --
 * it is the easiest thing in the sky to photograph, day or night, and the
 * best target for checking the overlay is aligned.
 */
export function tonight(frame: SkyFrame, data: SkyData, limit = 30): TonightEntry[] {
  const entries: TonightEntry[] = [];

  frame.objects.forEach((object, index) => {
    if (object.altitude <= 0) return;
    if (object.kind === 'sun') return;

    entries.push({
      label: object.name,
      detail:
        object.kind === 'moon'
          ? `${Math.round((object.illumination ?? 0) * 100)}% lit`
          : object.kind === 'deepsky'
            ? `${object.objectType} · ${object.designation}`
            : object.kind === 'asteroid'
              ? `Asteroid · ${object.designation}`
              : object.kind === 'shower'
                ? showerDetail(object)
                : 'Planet',
      magnitude: object.magnitude,
      altitude: object.altitude,
      azimuth: object.azimuth,
      index: -1 - index,
      kind: object.kind,
      washedOut: object.kind === 'moon' ? false : object.magnitude > frame.limitingMagnitude,
    });
  });

  // Named stars only: a list of 400 catalogue numbers helps nobody.
  for (let i = 0; i < frame.starCount; i += 1) {
    if (!(frame.stars.visible[i] as number)) continue;

    const hip = frame.catalog.hip[i] as number;
    const name = data.names.get(hip);
    if (!name?.proper) continue;

    const magnitude = frame.catalog.mag[i] as number;
    entries.push({
      label: name.proper,
      detail: name.constellation ? `Star · ${name.constellation}` : 'Star',
      magnitude,
      altitude: frame.stars.altitude[i] as number,
      azimuth: frame.stars.azimuth[i] as number,
      index: i,
      kind: 'star',
      washedOut: magnitude > frame.limitingMagnitude,
    });
  }

  // Observable-now first; washed-out entries trail, each group ordered
  // brightest first. Mixing the two by raw magnitude would bury the useful
  // half of the list under objects nobody can actually see right now.
  entries.sort((a, b) => Number(a.washedOut) - Number(b.washedOut) || a.magnitude - b.magnitude);
  return entries.slice(0, limit);
}

/**
 * A line explaining what the list is showing: what's actually observable, and
 * why the rest is not -- more honest than a caption that only counts what is
 * above the horizon and leaves daylight or moonlight unexplained.
 */
export function skyCaption(frame: SkyFrame, entries: TonightEntry[]): string {
  const washedOut = entries.reduce((count, entry) => count + (entry.washedOut ? 1 : 0), 0);
  const observable = entries.length - washedOut;
  if (washedOut === 0) return `${observable} observable now`;

  // Below -18 degrees the sky is as dark as this model gets, so anything
  // still washed out there is the Moon's doing, not the Sun's.
  const reason = frame.sunAltitude > 0 ? 'daylight' : frame.sunAltitude > -18 ? 'twilight' : 'moonlight';
  return `${observable} observable now · ${washedOut} more washed out by ${reason}`;
}

export interface ObjectDetail {
  title: string;
  subtitle: string;
  chips: string[];
  stats: [string, string][];
  footer: string;
}

/** Everything the info card shows about whatever is selected. */
export function describe(index: number, frame: SkyFrame, data: SkyData): ObjectDetail | null {
  const degrees = (value: number): string => `${value.toFixed(1)}°`;
  const clock = (date: Date | null): string =>
    date
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      : '—';

  if (index < 0) {
    const object = frame.objects[-1 - index];
    if (!object) return null;

    const events = riseTransitSet(
      object.ra,
      object.dec,
      frame.observer,
      frame.when,
      object.kind === 'moon'
        ? RISE_SET_ALTITUDE.moon
        : object.kind === 'sun'
          ? RISE_SET_ALTITUDE.sun
          : RISE_SET_ALTITUDE.star,
    );

    if (object.kind === 'shower') {
      const days = object.daysToPeak ?? 0;
      return {
        title: object.name,
        subtitle: `Radiant · ${object.designation}`,
        chips: [
          'Meteor shower',
          object.altitude > 0 ? 'Radiant up' : 'Radiant below horizon',
        ],
        stats: [
          ['Peak', object.peak ?? '—'],
          [
            'Best',
            days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : days === 0 ? 'tonight' : `${-days} days ago`,
          ],
          ['Rate at peak', `~${object.hourlyRate}/hr`],
          ['Altitude', degrees(object.altitude)],
          ['Azimuth', degrees(object.azimuth)],
          ['Rises', events.circumpolar ? 'always up' : clock(events.rise)],
        ],
        // The two things that most often disappoint someone who went out for
        // a shower, said before they go rather than after.
        footer:
          'Meteors appear anywhere in the sky and only seem to come from here -- ' +
          'the quoted rate assumes a dark sky with the radiant overhead.',
      };
    }

    if (object.kind === 'deepsky') {
      const arcmin = (degrees: number): string => `${(degrees * 60).toFixed(0)}'`;
      return {
        title: object.name,
        subtitle: object.designation ?? '',
        chips: [
          object.objectType ?? 'Deep sky',
          object.altitude > 0 ? 'Above horizon' : 'Below horizon',
        ],
        stats: [
          ['Magnitude', object.magnitude.toFixed(1)],
          ['Altitude', degrees(object.altitude)],
          ['Azimuth', degrees(object.azimuth)],
          [
            'Apparent size',
            `${arcmin(object.angularDiameter)} × ${arcmin(object.angularMinor ?? object.angularDiameter)}`,
          ],
          ['Rises', events.circumpolar ? 'always up' : clock(events.rise)],
          ['Sets', events.circumpolar ? 'never' : clock(events.set)],
        ],
        // Why the magnitude flatters it: a star puts all its light in one
        // point, this spreads the same number across a patch of sky.
        footer: 'Extended, not a point -- it looks fainter than the magnitude suggests.',
      };
    }

    return {
      title: object.name,
      subtitle:
        object.kind === 'moon'
          ? `${Math.round((object.illumination ?? 0) * 100)}% illuminated`
          : object.kind === 'sun'
            ? 'The Sun'
            : object.kind === 'asteroid'
              ? (object.designation ?? 'Asteroid')
              : 'Planet',
      chips: [
        object.kind === 'moon'
          ? 'Satellite'
          : object.kind === 'sun'
            ? 'Star'
            : object.kind === 'asteroid'
              ? 'Asteroid'
              : 'Planet',
        object.altitude > 0 ? 'Above horizon' : 'Below horizon',
      ],
      stats: [
        ['Magnitude', object.magnitude.toFixed(1)],
        ['Altitude', degrees(object.altitude)],
        ['Azimuth', degrees(object.azimuth)],
        [
          'Distance',
          object.distanceUnit === 'km'
            ? `${Math.round(object.distance).toLocaleString()} km`
            : `${object.distance.toFixed(2)} au`,
        ],
        [
          'Apparent size',
          object.angularDiameter > 0 ? `${(object.angularDiameter * 60).toFixed(1)}'` : '—',
        ],
        ['Sets', events.circumpolar ? 'never' : clock(events.set)],
      ],
      footer:
        object.kind === 'moon'
          ? 'The easiest target for checking the overlay is lined up.'
          : object.kind === 'asteroid'
            ? // Said plainly because it is the one place in the app where the
              // maths degrades with the calendar rather than staying put.
              frame.asteroidsStale
              ? 'Orbital elements are past the window they were fitted for -- the position will have drifted.'
              : 'A two-body orbit fitted to a recent epoch, computed on this device.'
            : 'Position computed on this device from orbital elements.',
    };
  }

  if (index >= frame.starCount) return null;

  const hip = frame.catalog.hip[index] as number;
  const name = data.names.get(hip);
  const magnitude = frame.catalog.mag[index] as number;
  const altitude = frame.stars.altitude[index] as number;
  const azimuth = frame.stars.azimuth[index] as number;

  const events = riseTransitSet(
    frame.catalog.ra[index] as number,
    frame.catalog.dec[index] as number,
    frame.observer,
    frame.when,
  );

  const chips: string[] = [];
  if (name?.bayer && name.constellation) chips.push(`${name.bayer} ${name.constellation}`);
  if (events.circumpolar) chips.push('Never sets');
  else if (events.neverRises) chips.push('Never rises here');

  return {
    title: starLabel(hip, data.names),
    subtitle: name?.constellation ? constellationName(name.constellation, data) : `HIP ${hip}`,
    chips,
    stats: [
      ['Magnitude', magnitude.toFixed(2)],
      ['Altitude', degrees(altitude)],
      ['Azimuth', degrees(azimuth)],
      ['Distance', name?.lightYears ? `${Math.round(name.lightYears)} ly` : '—'],
      ['Rises', events.circumpolar ? 'always up' : clock(events.rise)],
      ['Sets', events.circumpolar ? 'never' : clock(events.set)],
    ],
    footer: `HIP ${hip} · position precessed to today`,
  };
}

function constellationName(abbr: string, data: SkyData): string {
  const found = data.figures.byName.find((c) => c.abbr === abbr);
  if (!found) return abbr;
  return found.common ? `${found.name} · the ${found.common}` : found.name;
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

/**
 * Find objects by name.
 *
 * Returns the same shape as {@link tonight} so both lists share one renderer
 * and one selection path.
 *
 * Three kinds of thing match:
 *
 *   - the Moon, the Sun and the five planets, by name
 *   - stars with a proper name, or a Bayer/Flamsteed designation
 *   - constellations, which resolve to their brightest visible member, because
 *     "where is Orion" is answered by pointing at Betelgeuse, not at a centroid
 *     in empty sky
 *
 * Below-the-horizon matches are kept and marked. Hiding them answers "where is
 * Jupiter" with silence, when the useful answer is "under your feet right now".
 */
export function search(
  query: string,
  frame: SkyFrame,
  data: SkyData,
  limit = 24,
): TonightEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 1) return [];

  interface Scored {
    entry: TonightEntry;
    score: number;
  }
  const found: Scored[] = [];

  // Prefix matches beat substring matches, and short names beat long ones, so
  // "mar" finds Mars before Markab.
  const rank = (haystack: string): number => {
    const hay = haystack.toLowerCase();
    if (hay === needle) return 0;
    if (hay.startsWith(needle)) return 1 + hay.length / 100;
    if (hay.includes(needle)) return 3 + hay.length / 100;
    return Number.POSITIVE_INFINITY;
  };

  const horizonNote = (altitude: number, base: string): string =>
    altitude > 0 ? base : `${base} · below the horizon`;

  frame.objects.forEach((object, index) => {
    // A deep-sky object answers to its catalogue numbers as much as its name:
    // "M31" and "NGC 224" have to find the Andromeda Galaxy.
    const score = Math.min(
      rank(object.name),
      object.designation ? rank(object.designation) : Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(score)) return;
    found.push({
      score,
      entry: {
        label: object.name,
        detail: horizonNote(
          object.altitude,
          object.kind === 'moon'
            ? 'Moon'
            : object.kind === 'sun'
              ? 'Sun'
              : object.kind === 'deepsky'
                ? `${object.objectType} · ${object.designation}`
                : object.kind === 'asteroid'
                  ? `Asteroid · ${object.designation}`
                  : object.kind === 'shower'
                    ? showerDetail(object)
                    : 'Planet',
        ),
        magnitude: object.magnitude,
        altitude: object.altitude,
        azimuth: object.azimuth,
        index: -1 - index,
        kind: object.kind,
        washedOut: object.kind === 'moon' ? false : object.magnitude > frame.limitingMagnitude,
      },
    });
  });

  for (let i = 0; i < frame.starCount; i += 1) {
    const hip = frame.catalog.hip[i] as number;
    const name = data.names.get(hip);
    if (!name) continue;

    const candidates = [
      name.proper,
      name.bayer && name.constellation ? `${name.bayer} ${name.constellation}` : undefined,
      name.flamsteed && name.constellation ? `${name.flamsteed} ${name.constellation}` : undefined,
    ].filter((value): value is string => Boolean(value));

    let best = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) best = Math.min(best, rank(candidate));
    if (!Number.isFinite(best)) continue;

    found.push({
      score: best,
      entry: {
        label: starLabel(hip, data.names),
        detail: horizonNote(
          frame.stars.altitude[i] as number,
          name.constellation ? `Star · ${name.constellation}` : 'Star',
        ),
        magnitude: frame.catalog.mag[i] as number,
        altitude: frame.stars.altitude[i] as number,
        azimuth: frame.stars.azimuth[i] as number,
        index: i,
        kind: 'star',
        washedOut: (frame.catalog.mag[i] as number) > frame.limitingMagnitude,
      },
    });
  }

  // Constellations resolve to their brightest member.
  for (const constellation of data.figures.byName) {
    const score = Math.min(
      rank(constellation.name),
      constellation.common ? rank(constellation.common) : Number.POSITIVE_INFINITY,
      rank(constellation.abbr),
    );
    if (!Number.isFinite(score)) continue;

    let brightest = -1;
    for (let s = constellation.start; s < constellation.end; s += 1) {
      for (const vertex of [
        data.figures.segments[s * 2] as number,
        data.figures.segments[s * 2 + 1] as number,
      ]) {
        if (vertex >= frame.starCount) continue;
        if (brightest === -1 || (frame.catalog.mag[vertex] as number) < (frame.catalog.mag[brightest] as number)) {
          brightest = vertex;
        }
      }
    }
    if (brightest === -1) continue;

    found.push({
      // Slightly behind an equally-good star match: someone typing a star name
      // wants the star.
      score: score + 0.5,
      entry: {
        label: constellation.name,
        detail: horizonNote(
          frame.stars.altitude[brightest] as number,
          constellation.common ? `Constellation · the ${constellation.common}` : 'Constellation',
        ),
        magnitude: frame.catalog.mag[brightest] as number,
        altitude: frame.stars.altitude[brightest] as number,
        azimuth: frame.stars.azimuth[brightest] as number,
        index: brightest,
        kind: 'star',
        washedOut: (frame.catalog.mag[brightest] as number) > frame.limitingMagnitude,
      },
    });
  }

  found.sort((a, b) => a.score - b.score || a.entry.magnitude - b.entry.magnitude);

  // One entry per object: a star can match on both its proper name and its
  // Bayer designation.
  const seen = new Set<number>();
  const results: TonightEntry[] = [];
  for (const { entry } of found) {
    if (seen.has(entry.index)) continue;
    seen.add(entry.index);
    results.push(entry);
    if (results.length >= limit) break;
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * Calibration
 * ------------------------------------------------------------------ */

/**
 * Objects bright enough to aim at unambiguously, for compass calibration.
 *
 * Deep-sky objects are excluded however bright: the Pleiades clears the
 * magnitude bar easily and is two and a half degrees wide, so nobody can put
 * a crosshair on its centre to better than the error being measured.
 */
export function calibrationTargets(frame: SkyFrame, data: SkyData, limit = 8): TonightEntry[] {
  return tonight(frame, data, 60)
    .filter(
      (entry) =>
        // Neither a smudge nor a radiant is a point you can put a crosshair
        // on, which is the whole job here.
        entry.kind !== 'deepsky' &&
        entry.kind !== 'shower' &&
        entry.altitude > 12 &&
        entry.altitude < 78 &&
        entry.magnitude < 2,
    )
    .slice(0, limit);
}

export interface CalibrationResult {
  /** Degrees to add to the sensor heading. */
  offset: number;
  /** The heading the sensors reported. */
  reported: number;
  /** The heading the object is actually at. */
  actual: number;
}

/**
 * Work out the compass error from one sighting.
 *
 * The user aims the crosshair at an object they can see and confirms. Whatever
 * the sensors claim the heading is, the object's true azimuth is known exactly,
 * so the difference is the magnetometer's error -- local iron, a phone case, a
 * miscalibrated sensor, all of it at once.
 *
 * Only azimuth is corrected. Altitude comes from the accelerometer measuring
 * gravity, which is accurate and cannot be thrown off by a nearby speaker.
 */
export function calibrate(reportedAzimuth: number, target: TonightEntry): CalibrationResult {
  const difference = ((target.azimuth - reportedAzimuth + 540) % 360) - 180;
  return { offset: difference, reported: reportedAzimuth, actual: target.azimuth };
}

export interface CombinedCalibration {
  /** Degrees to add to the sensor heading -- the circular mean of the kept sightings. */
  offset: number;
  /** How many sightings went into the average. */
  count: number;
  /** How many were thrown out as outliers, more than 90 degrees from the rest. */
  discarded: number;
}

/**
 * Combine several single-sighting offsets into one, more robust than trusting
 * any single sighting to noise -- a hand not quite steady, a target picked
 * just as a cloud passed over it. See {@link combineAngles} for the maths;
 * this just renames its fields to the calibration domain.
 */
export function combineCalibrations(offsets: number[]): CombinedCalibration {
  const combined = combineAngles(offsets);
  return { offset: combined.mean, count: combined.count, discarded: combined.discarded };
}
