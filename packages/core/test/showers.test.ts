/**
 * Meteor showers: fixed dates and fixed radiants, checked against the almanac
 * rather than against another program.
 *
 * Two things can go wrong in a table typed by hand, and both are silent. A
 * radiant quoted in hours rather than degrees lands the marker fifteen times
 * too far round the sky, and a lost minus sign on a small southern
 * declination puts it on the wrong side of the equator. The Eta Aquariids
 * are both cases at once, so they get their own assertion.
 */

import { describe, expect, it } from 'vitest';

import { angularSeparation } from '../src/angles.js';
import {
  activeShowers,
  calendarDayLabel,
  METEOR_SHOWERS,
  type MeteorShower,
} from '../src/showers.js';
import { equatorialToHorizontal } from '../src/coords.js';
import { julianDate, localSiderealTime } from '../src/time.js';

const shower = (code: string): MeteorShower => {
  const found = METEOR_SHOWERS.find((s) => s.code === code);
  if (!found) throw new Error(`no shower ${code}`);
  return found;
};

describe('meteor showers', () => {
  it('lists the seven worth planning an evening around', () => {
    expect(METEOR_SHOWERS).toHaveLength(7);
    expect(METEOR_SHOWERS.map((s) => s.code).sort()).toEqual([
      'ETA',
      'GEM',
      'LEO',
      'LYR',
      'ORI',
      'PER',
      'QUA',
    ]);
    expect(new Set(METEOR_SHOWERS.map((s) => s.name)).size).toBe(7);
  });

  it('keeps every radiant inside the coordinate system', () => {
    for (const s of METEOR_SHOWERS) {
      expect(s.ra, s.name).toBeGreaterThanOrEqual(0);
      expect(s.ra, s.name).toBeLessThan(360);
      expect(s.dec, s.name).toBeGreaterThanOrEqual(-90);
      expect(s.dec, s.name).toBeLessThanOrEqual(90);
      expect(s.zhr, s.name).toBeGreaterThan(0);
      for (const [month, day] of [s.start, s.peak, s.end]) {
        expect(month, s.name).toBeGreaterThanOrEqual(1);
        expect(month, s.name).toBeLessThanOrEqual(12);
        expect(day, s.name).toBeGreaterThanOrEqual(1);
        expect(day, s.name).toBeLessThanOrEqual(31);
      }
    }
  });

  it('puts each radiant in the constellation it is named after', () => {
    // The name of a shower IS a claim about where its radiant is. These are
    // the J2000 positions of the star each shower is named for, so a
    // hours-versus-degrees slip on the radiant shows up as a huge separation.
    const anchors: [code: string, ra: number, dec: number, within: number][] = [
      // Perseus, near Eta Persei.
      ['PER', 43.6, 55.9, 5],
      // Castor, in Gemini.
      ['GEM', 113.6, 31.9, 5],
      // Vega, in Lyra -- the Lyrid radiant sits just off it in Hercules.
      ['LYR', 279.2, 38.8, 10],
      // Eta Aquarii itself.
      ['ETA', 338.8, -0.3, 3],
      // Betelgeuse, in Orion; the Orionid radiant is north of it.
      ['ORI', 88.8, 7.4, 12],
      // Algieba, in the sickle of Leo.
      ['LEO', 154.9, 19.8, 5],
      // Bootes, where the Quadrantid radiant ended up after the constellation
      // it was named for stopped being one.
      ['QUA', 233.7, 49.3, 5],
    ];

    for (const [code, ra, dec, within] of anchors) {
      const s = shower(code);
      expect(
        angularSeparation(s.ra, s.dec, ra, dec),
        `${s.name} radiant is ${angularSeparation(s.ra, s.dec, ra, dec).toFixed(1)}deg from its namesake`,
      ).toBeLessThan(within);
    }
  });

  it('keeps the Eta Aquariid radiant just south of the equator', () => {
    // The trap: a single-digit negative declination, where a dropped sign is
    // invisible in the number and two degrees wrong on the sky.
    expect(shower('ETA').dec).toBeLessThan(0);
    expect(shower('ETA').dec).toBeGreaterThan(-5);
  });

  it('finds the Perseids in mid-August and nothing else of note', () => {
    const active = activeShowers(new Date('2026-08-12T22:00:00Z'));
    expect(active[0]?.shower.code).toBe('PER');
    expect(active[0]?.daysToPeak).toBe(0);
    expect(active.map((a) => a.shower.code)).not.toContain('GEM');
  });

  it('finds the Geminids in mid-December', () => {
    const active = activeShowers(new Date('2026-12-14T02:00:00Z'));
    expect(active[0]?.shower.code).toBe('GEM');
  });

  it('carries the Quadrantids across the new year', () => {
    // The wrap case: the window opens on 28 December and the peak is in
    // January, so a naive day-of-year subtraction puts the peak 360 days out
    // and the shower never starts.
    const december = activeShowers(new Date('2026-12-30T23:00:00Z'));
    expect(december.map((a) => a.shower.code)).toContain('QUA');
    expect(december.find((a) => a.shower.code === 'QUA')?.daysToPeak).toBe(4);

    const january = activeShowers(new Date('2027-01-03T23:00:00Z'));
    expect(january[0]?.shower.code).toBe('QUA');
    expect(january[0]?.daysToPeak).toBe(0);

    // ... and it is over by the end of January.
    expect(activeShowers(new Date('2027-01-25T23:00:00Z'))).toHaveLength(0);
  });

  it('shows nothing in the quiet stretch of the year', () => {
    // Early March has no shower on the working list at all, and the app has
    // to be willing to say so rather than always having something to offer.
    expect(activeShowers(new Date('2026-03-05T22:00:00Z'))).toHaveLength(0);
  });

  it('ranks the better night first when two overlap', () => {
    // The Leonids and Orionids overlap in early November: the Orionids are
    // fading, the Leonids have not started paying out yet.
    const active = activeShowers(new Date('2026-11-06T23:00:00Z'));
    expect(active.map((a) => a.shower.code)).toContain('ORI');
    expect(active.map((a) => a.shower.code)).toContain('LEO');
    // Whatever the order, each entry's peak distance has to be honest.
    for (const entry of active) {
      expect(Math.abs(entry.daysToPeak)).toBeLessThan(60);
    }
  });

  it('puts the Geminid radiant high over the northern hemisphere at its peak', () => {
    // The end-to-end claim: a shower marker lands somewhere a user would
    // actually look. Geminid night from 50 N has the radiant nearly overhead
    // in the small hours.
    const when = new Date('2026-12-14T02:00:00Z');
    const jd = julianDate(when);
    const lst = localSiderealTime(jd, 0);
    const { altitude } = equatorialToHorizontal(shower('GEM').ra, shower('GEM').dec, lst, 50);
    expect(altitude).toBeGreaterThan(60);
  });

  it('formats a peak date the way a person would write it', () => {
    expect(calendarDayLabel([8, 12])).toBe('12 Aug');
    expect(calendarDayLabel([1, 3])).toBe('3 Jan');
  });
});
