/**
 * The deep-sky catalogue, checked the same way the rest of this package is:
 * against things you can look up in a book rather than against another
 * program. M31 sits where it has always sat, M7 is well south of the equator,
 * and the Andromeda Galaxy is three degrees wide, not three arcminutes.
 *
 * The position checks earn their keep on the build side: right ascension
 * arrives from the source as "HH:MM:SS" and declination as "+DD:MM:SS", and
 * both the hours-to-degrees factor and the sign on a negative declination
 * whose degrees field is zero are easy to get wrong and silent when you do.
 */

import { describe, expect, it } from 'vitest';

import {
  DEEP_SKY_TYPE_NAMES,
  deepSkyDesignation,
  deepSkyLabel,
  parseDeepSky,
  type DeepSkyObject,
} from '../src/deepsky.js';
import { riseTransitSet } from '../src/coords.js';
import { deepSkyJson } from './fixtures.js';

const objects = parseDeepSky(deepSkyJson);
const messier = (number: number): DeepSkyObject => {
  const found = objects.find((object) => object.messier === number);
  if (!found) throw new Error(`M${number} is not in the catalogue`);
  return found;
};

describe('deep-sky catalogue', () => {
  it('parses every row the header claims', () => {
    expect(objects).toHaveLength(deepSkyJson.count);
    expect(objects.every((object) => Number.isFinite(object.ra))).toBe(true);
    expect(objects.every((object) => Number.isFinite(object.dec))).toBe(true);
  });

  it('lists each Messier object exactly once', () => {
    const numbers = objects.map((object) => object.messier);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.every((number) => number >= 1 && number <= 110)).toBe(true);
  });

  it('stays inside the naked-eye cutoff the catalogue advertises', () => {
    for (const object of objects) expect(object.mag).toBeLessThanOrEqual(deepSkyJson.magLimit);
  });

  it('is sorted brightest first, so a magnitude cutoff is a slice', () => {
    for (let i = 1; i < objects.length; i += 1) {
      expect((objects[i] as DeepSkyObject).mag).toBeGreaterThanOrEqual(
        (objects[i - 1] as DeepSkyObject).mag,
      );
    }
  });

  it('puts M31 where the almanacs put it', () => {
    const m31 = messier(31);
    expect(m31.ra).toBeCloseTo(10.68, 1);
    expect(m31.dec).toBeCloseTo(41.27, 1);
    expect(m31.type).toBe('galaxy');
    expect(m31.name).toBe('Andromeda Galaxy');
    expect(m31.ngc).toBe(224);
  });

  it('keeps southern declinations negative', () => {
    // M7 is in the tail of Scorpius, a long way below the equator. Its
    // catalogue declination is -34:48, which is also the case that breaks if
    // the sign is read off the degrees field after it has been parsed.
    expect(messier(7).dec).toBeCloseTo(-34.79, 1);
    // M10's declination is -04:06: a single-digit degrees field, where a lost
    // minus sign lands the object four degrees the wrong side of the equator.
    expect(messier(10).dec).toBeLessThan(0);
  });

  it('converts apparent sizes from arcminutes to degrees', () => {
    // M31 is a bit under three degrees on the long axis -- six Moons -- and
    // markedly flattened, which is why the minor axis ships at all.
    const m31 = messier(31);
    expect(m31.major).toBeCloseTo(177.8 / 60, 3);
    expect(m31.minor).toBeLessThan(m31.major / 2);

    // A round object gets its major axis repeated rather than a zero, or the
    // renderer would draw it as a horizontal line.
    for (const object of objects) expect(object.minor).toBeGreaterThan(0);
  });

  it('only uses type names the app knows how to print', () => {
    for (const object of objects) expect(DEEP_SKY_TYPE_NAMES[object.type]).toBeTruthy();
  });

  it('falls back to the Messier number when there is no common name', () => {
    // M45 has a name everybody uses; M37 has never had one.
    expect(deepSkyLabel(messier(45))).toBe('Pleiades');
    expect(deepSkyLabel(messier(37))).toBe('M37');
  });

  it('carries the NGC number in the designation, and omits it when there is none', () => {
    expect(deepSkyDesignation(messier(31))).toBe('M31 · NGC 224');
    // The Pleiades is in neither the NGC nor the IC.
    expect(messier(45).ngc).toBeUndefined();
    expect(deepSkyDesignation(messier(45))).toBe('M45');
  });

  it('gives positions the rise/set machinery agrees with', () => {
    const when = new Date('2024-03-20T00:00:00Z');

    // M31 at declination +41 never sets from Edinburgh (56 N): 41 + 56 is
    // comfortably past 90.
    expect(
      riseTransitSet(messier(31).ra, messier(31).dec, { latitude: 56, longitude: -3 }, when)
        .circumpolar,
    ).toBe(true);

    // ... and from the same place M7, at -35, never comes up at all.
    expect(
      riseTransitSet(messier(7).ra, messier(7).dec, { latitude: 56, longitude: -3 }, when)
        .neverRises,
    ).toBe(true);
  });
});
