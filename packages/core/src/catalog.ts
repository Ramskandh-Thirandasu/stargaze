/**
 * The star catalogue, in a shape built for the render loop.
 *
 * Typed parallel arrays rather than an array of objects: the whole catalogue
 * has to be transformed every time the sky is recomputed, and this keeps it in
 * a handful of contiguous buffers instead of nine thousand scattered objects
 * for the garbage collector to trip over.
 */

import { toDegrees, toRadians } from './angles.js';
import { apparentTerms, applyApparentPlace } from './apparent.js';
import { precessFromJ2000, refraction } from './coords.js';
import { J2000, terrestrialJulianDate } from './time.js';

/** The generated `stars.json`, as it arrives from the network. */
export interface StarCatalogJson {
  epoch: string;
  magLimit: number;
  count: number;
  hip: number[];
  ra: number[];
  dec: number[];
  mag: number[];
  ci: number[];
  /** Proper motion, mas/yr, J2000 epoch. `pmra` is already times cos(dec) --
   *  the standard astrometric convention. Absent from older catalogue builds,
   *  in which case it's treated as all zero (no motion applied). */
  pmra?: number[];
  pmdec?: number[];
}

/** Catalogue positions, J2000. Sorted brightest first. */
export interface StarCatalog {
  count: number;
  hip: Int32Array;
  /** J2000 right ascension, degrees. */
  ra: Float64Array;
  /** J2000 declination, degrees. */
  dec: Float64Array;
  mag: Float32Array;
  /** B-V colour index. */
  ci: Float32Array;
  /** Proper motion in RA, mas/yr, times cos(dec). */
  pmra: Float32Array;
  /** Proper motion in Dec, mas/yr. */
  pmdec: Float32Array;
  /** HIP number to array index, for constellation lookup. */
  indexOfHip: Map<number, number>;
}

export function parseStarCatalog(json: StarCatalogJson): StarCatalog {
  const count = json.count;
  const hip = Int32Array.from(json.hip);
  const indexOfHip = new Map<number, number>();
  for (let i = 0; i < count; i += 1) indexOfHip.set(hip[i] as number, i);

  return {
    count,
    hip,
    ra: Float64Array.from(json.ra),
    dec: Float64Array.from(json.dec),
    mag: Float32Array.from(json.mag),
    ci: Float32Array.from(json.ci),
    pmra: json.pmra ? Float32Array.from(json.pmra) : new Float32Array(count),
    pmdec: json.pmdec ? Float32Array.from(json.pmdec) : new Float32Array(count),
    indexOfHip,
  };
}

/**
 * How many of the (brightest-first) stars fall within a magnitude cutoff.
 *
 * Because the catalogue is sorted, filtering by brightness is a binary search
 * and a slice rather than a scan.
 */
export function countBrighterThan(catalog: StarCatalog, magnitude: number): number {
  let low = 0;
  let high = catalog.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((catalog.mag[middle] as number) <= magnitude) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Catalogue positions moved to the equinox of a given date. */
export interface PrecessedCatalog {
  count: number;
  ra: Float64Array;
  dec: Float64Array;
  jd: number;
}

/** Julian days in a Julian year -- the unit proper motion rates are quoted in. */
const DAYS_PER_YEAR = 365.25;

/** milliarcseconds to degrees. */
const MAS_TO_DEG = 1 / 3600000;

/**
 * Move a J2000 catalogue position by proper motion to `jd`, in the star's own
 * fixed (ICRS) frame -- this has to happen before precession, which then
 * carries the whole frame to the equinox of date. Getting the order backwards
 * mixes a frame rotation into a straight-line motion and is wrong by a small
 * but real amount for anything with real proper motion.
 *
 * `pmra` is already times cos(dec) (the standard convention), so it has to be
 * divided back out to get the actual change in right ascension.
 */
function applyProperMotion(
  ra: number,
  dec: number,
  pmraMasYr: number,
  pmdecMasYr: number,
  jd: number,
): { ra: number; dec: number } {
  if (pmraMasYr === 0 && pmdecMasYr === 0) return { ra, dec };

  const years = (jd - J2000) / DAYS_PER_YEAR;
  const decRad = toRadians(dec);
  const movedDec = dec + pmdecMasYr * MAS_TO_DEG * years;
  const movedRa = ra + (pmraMasYr * MAS_TO_DEG * years) / Math.cos(decRad);

  return { ra: movedRa, dec: movedDec };
}

/**
 * Precess the whole catalogue once.
 *
 * Precession moves stars by well under an arcsecond a day, so this belongs at
 * load time (or at most once a session), never in the frame loop. Proper
 * motion, nutation and annual aberration are folded into the same pass, since
 * all four only need recomputing on the same cadence -- see
 * {@link applyProperMotion} and {@link applyApparentPlace}. Nutation and
 * aberration's shared per-instant terms are hoisted out of the per-star loop,
 * the same way {@link toHorizontal} hoists the trigonometry that does not
 * depend on the individual star.
 */
export function precessCatalog(catalog: StarCatalog, jd: number): PrecessedCatalog {
  const ra = new Float64Array(catalog.count);
  const dec = new Float64Array(catalog.count);
  const terms = apparentTerms(terrestrialJulianDate(jd));

  for (let i = 0; i < catalog.count; i += 1) {
    const moved = applyProperMotion(
      catalog.ra[i] as number,
      catalog.dec[i] as number,
      catalog.pmra[i] as number,
      catalog.pmdec[i] as number,
      jd,
    );
    const precessed = precessFromJ2000(moved.ra, moved.dec, jd);
    const apparent = applyApparentPlace(precessed.ra, precessed.dec, terms);
    ra[i] = apparent.ra;
    dec[i] = apparent.dec;
  }

  return { count: catalog.count, ra, dec, jd };
}

/** Output buffers for {@link toHorizontal}, allocated once and reused. */
export interface HorizontalBuffer {
  altitude: Float32Array;
  azimuth: Float32Array;
  /** 1 when the star is above the horizon. */
  visible: Uint8Array;
  count: number;
}

export function createHorizontalBuffer(count: number): HorizontalBuffer {
  return {
    altitude: new Float32Array(count),
    azimuth: new Float32Array(count),
    visible: new Uint8Array(count),
    count,
  };
}

/**
 * Transform the catalogue into the observer's sky.
 *
 * This is the hot loop. It is written flat and allocation-free on purpose: the
 * trigonometry that does not depend on the individual star is hoisted out, so
 * each star costs one sin, one cos and an atan2 rather than six.
 *
 * `limit` lets the caller transform only the brightest N -- see
 * {@link countBrighterThan}. `refract` adds atmospheric refraction to the
 * altitude (see {@link refraction}) -- on by default, since that is what is
 * actually visible; turn it off for a true (airless) altitude.
 */
export function toHorizontal(
  precessed: PrecessedCatalog,
  lst: number,
  latitude: number,
  out: HorizontalBuffer,
  limit: number = precessed.count,
  refract: boolean = true,
): void {
  const latRad = toRadians(latitude);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const lstRad = toRadians(lst);
  const DEG = Math.PI / 180;

  const n = Math.min(limit, precessed.count, out.count);

  for (let i = 0; i < n; i += 1) {
    const decRad = (precessed.dec[i] as number) * DEG;
    const hourAngle = lstRad - (precessed.ra[i] as number) * DEG;

    const sinDec = Math.sin(decRad);
    const cosDec = Math.cos(decRad);
    const sinH = Math.sin(hourAngle);
    const cosH = Math.cos(hourAngle);

    const sinAlt = sinDec * sinLat + cosDec * cosLat * cosH;
    let altitude = toDegrees(Math.asin(sinAlt < -1 ? -1 : sinAlt > 1 ? 1 : sinAlt));
    if (refract) altitude += refraction(altitude);

    let azimuth = toDegrees(
      Math.atan2(-cosDec * sinH, sinDec * cosLat - cosDec * sinLat * cosH),
    );
    if (azimuth < 0) azimuth += 360;

    out.altitude[i] = altitude;
    out.azimuth[i] = azimuth;
    out.visible[i] = altitude > 0 ? 1 : 0;
  }
}

/** The generated `constellations.json`. */
export interface ConstellationJson {
  vertexId: 'hip';
  constellations: { abbr: string; name: string; common?: string; lines: number[][] }[];
}

/** Constellation figures with HIP numbers resolved to catalogue indices. */
export interface ConstellationFigures {
  /** Flat pairs of catalogue indices: [a0, b0, a1, b1, ...]. */
  segments: Int32Array;
  /** Per-constellation slices into `segments`, for labelling and filtering. */
  byName: {
    abbr: string;
    /** Latin IAU name, e.g. "Orion". */
    name: string;
    /** English translation, e.g. "Hunter". Absent when it matches the name. */
    common?: string;
    start: number;
    end: number;
  }[];
}

/**
 * Resolve figures against a catalogue.
 *
 * Segments are stored as flat index pairs, so drawing is a straight walk with
 * no lookups. Any vertex the catalogue is missing drops the segment rather than
 * drawing a line to the wrong star.
 */
export function resolveConstellations(
  json: ConstellationJson,
  catalog: StarCatalog,
): ConstellationFigures {
  const pairs: number[] = [];
  const byName: ConstellationFigures['byName'] = [];

  for (const constellation of json.constellations) {
    const start = pairs.length / 2;

    for (const polyline of constellation.lines) {
      for (let i = 0; i + 1 < polyline.length; i += 1) {
        const a = catalog.indexOfHip.get(polyline[i] as number);
        const b = catalog.indexOfHip.get(polyline[i + 1] as number);
        if (a === undefined || b === undefined) continue;
        pairs.push(a, b);
      }
    }

    byName.push({
      abbr: constellation.abbr,
      name: constellation.name,
      ...(constellation.common === undefined ? {} : { common: constellation.common }),
      start,
      end: pairs.length / 2,
    });
  }

  return { segments: Int32Array.from(pairs), byName };
}

/** The generated `names.json`. */
export interface StarNamesJson {
  stars: Record<string, { n?: string; b?: string; f?: string; c?: string; ly?: number }>;
}

export interface StarName {
  /** Proper name, e.g. "Betelgeuse". */
  proper?: string;
  /** Bayer designation, e.g. "Alp". */
  bayer?: string;
  /** Flamsteed number. */
  flamsteed?: string;
  /** IAU constellation abbreviation. */
  constellation?: string;
  /** Distance in light years. */
  lightYears?: number;
}

export function parseStarNames(json: StarNamesJson): Map<number, StarName> {
  const names = new Map<number, StarName>();

  for (const [hip, entry] of Object.entries(json.stars)) {
    const name: StarName = {};
    if (entry.n !== undefined) name.proper = entry.n;
    if (entry.b !== undefined) name.bayer = entry.b;
    if (entry.f !== undefined) name.flamsteed = entry.f;
    if (entry.c !== undefined) name.constellation = entry.c;
    if (entry.ly !== undefined) name.lightYears = entry.ly;
    names.set(Number(hip), name);
  }

  return names;
}

/**
 * Approximate RGB for a B-V colour index.
 *
 * Real stars are not white. Rigel is blue, Betelgeuse is orange, and rendering
 * both as grey dots throws away the easiest cue for telling them apart.
 * Values follow the usual blackbody approximation, clamped to the range real
 * stars occupy.
 */
export function colorFromBV(bv: number): { r: number; g: number; b: number } {
  const t = Math.max(-0.4, Math.min(2.0, bv));

  // Piecewise fit: hot blue-white through to cool red.
  let r: number;
  let g: number;
  let b: number;

  if (t < 0.0) {
    r = 0.61 + 0.11 * t + 0.1 * t * t;
    g = 0.7 + 0.07 * t + 0.1 * t * t;
    b = 1.0;
  } else if (t < 0.4) {
    r = 0.83 + 0.17 * t;
    g = 0.87 + 0.11 * t;
    b = 1.0;
  } else if (t < 1.6) {
    r = 1.0;
    g = 0.98 - 0.16 * (t - 0.4);
    b = 1.0 - 0.47 * (t - 0.4) + 0.1 * (t - 0.4) * (t - 0.4);
  } else {
    r = 1.0;
    g = 0.79 - 0.1 * (t - 1.6);
    b = 0.42 - 0.05 * (t - 1.6);
  }

  return {
    r: Math.max(0, Math.min(1, r)),
    g: Math.max(0, Math.min(1, g)),
    b: Math.max(0, Math.min(1, b)),
  };
}
