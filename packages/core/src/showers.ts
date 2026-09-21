/**
 * Meteor showers, as fixed radiants on fixed dates.
 *
 * Unlike everything else in this package there is no orbit to solve. A shower
 * is the Earth crossing a debris stream it crosses at the same point of its
 * own orbit every year, so the date and the direction the meteors come from
 * are both effectively constants -- which is why this is a table rather than a
 * generated catalogue, and why it works offline without shipping a byte.
 *
 * The dates drift by a day or so against the calendar, because the calendar
 * and the orbit disagree about the length of a year. That is smaller than the
 * width of the activity window, and far smaller than the difference a cloud
 * makes, so no attempt is made to chase it with solar longitude.
 *
 * Values are the IMO Working List of Visual Meteor Showers.
 */

/** A shower's window and peak, as [month, day] with month 1-12. */
export type CalendarDay = [month: number, day: number];

export interface MeteorShower {
  /** "Perseids". */
  name: string;
  /** IAU three-letter code, "PER". */
  code: string;
  /** J2000 right ascension of the radiant, degrees. */
  ra: number;
  /** J2000 declination of the radiant, degrees. */
  dec: number;
  start: CalendarDay;
  peak: CalendarDay;
  end: CalendarDay;
  /**
   * Zenithal hourly rate at the peak: what one observer would count under a
   * perfect sky with the radiant overhead. Nobody ever sees this number. It
   * is the published figure and the app says so rather than inventing a
   * discounted one.
   */
  zhr: number;
}

/**
 * The seven anyone would plan an evening around.
 *
 * Radiants are J2000, the same frame the star catalogue uses, so they ride the
 * same precession and apparent-place pipeline as everything else.
 *
 * The Eta Aquariids' declination is -1: a single-digit southern declination is
 * exactly where a sign gets lost in transcription, so showers.test.ts asserts
 * it explicitly.
 */
export const METEOR_SHOWERS: readonly MeteorShower[] = [
  {
    name: 'Quadrantids',
    code: 'QUA',
    ra: 230,
    dec: 49,
    start: [12, 28],
    peak: [1, 3],
    end: [1, 12],
    zhr: 110,
  },
  {
    name: 'Lyrids',
    code: 'LYR',
    ra: 271,
    dec: 34,
    start: [4, 14],
    peak: [4, 22],
    end: [4, 30],
    zhr: 18,
  },
  {
    name: 'Eta Aquariids',
    code: 'ETA',
    ra: 338,
    dec: -1,
    start: [4, 19],
    peak: [5, 6],
    end: [5, 28],
    zhr: 50,
  },
  {
    name: 'Perseids',
    code: 'PER',
    ra: 48,
    dec: 58,
    start: [7, 17],
    peak: [8, 12],
    end: [8, 24],
    zhr: 100,
  },
  {
    name: 'Orionids',
    code: 'ORI',
    ra: 95,
    dec: 16,
    start: [10, 2],
    peak: [10, 21],
    end: [11, 7],
    zhr: 20,
  },
  {
    name: 'Leonids',
    code: 'LEO',
    ra: 152,
    dec: 22,
    start: [11, 6],
    peak: [11, 17],
    end: [11, 30],
    zhr: 15,
  },
  {
    name: 'Geminids',
    code: 'GEM',
    ra: 112,
    dec: 33,
    start: [12, 4],
    peak: [12, 14],
    end: [12, 20],
    zhr: 150,
  },
];

/**
 * The brightness to expect from the meteors themselves, not from the radiant
 * -- there is nothing at a radiant to see.
 *
 * The visual meteor population for these showers peaks around second
 * magnitude. Carrying it as a magnitude lets a radiant obey exactly the same
 * rules as every other marker in the app: it disappears when the user's
 * magnitude setting is below it, and it dims when the Moon washes the sky out
 * -- which is not a fudge, since a full Moon genuinely ruins a shower.
 */
export const METEOR_MAGNITUDE = 2;

/** Days per month in a common year. */
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Day of the year, 1-365, ignoring leap days. See the module comment. */
function dayOfYear([month, day]: CalendarDay): number {
  let total = day;
  for (let m = 0; m < month - 1; m += 1) total += MONTH_LENGTHS[m] as number;
  return total;
}

/**
 * Signed days from `when` to `day`, taking the shorter way round the year.
 *
 * The wrap is not a nicety: the Quadrantids run from late December into
 * January, and a plain subtraction puts their peak 362 days away on New
 * Year's Eve.
 */
function daysBetween(when: Date, day: CalendarDay): number {
  const today = dayOfYear([when.getUTCMonth() + 1, when.getUTCDate()]);
  const difference = dayOfYear(day) - today;
  if (difference > 182) return difference - 365;
  if (difference < -182) return difference + 365;
  return difference;
}

export interface ActiveShower {
  shower: MeteorShower;
  /** Days to the peak; negative once it has passed. */
  daysToPeak: number;
}

/**
 * Which showers are running on a given date, best first.
 *
 * "Best" is the published rate discounted by how far the date is from the
 * peak, so a Perseid evening a week early does not outrank Geminid night.
 * Ordering only -- the rate reported to the user stays the published one.
 */
export function activeShowers(when: Date): ActiveShower[] {
  const active: ActiveShower[] = [];

  for (const shower of METEOR_SHOWERS) {
    // Inside the window when the start is behind us and the end is ahead,
    // both measured the short way round the year.
    if (daysBetween(when, shower.start) > 0) continue;
    if (daysBetween(when, shower.end) < 0) continue;
    active.push({ shower, daysToPeak: daysBetween(when, shower.peak) });
  }

  return active.sort(
    (a, b) =>
      b.shower.zhr / (1 + Math.abs(b.daysToPeak)) - a.shower.zhr / (1 + Math.abs(a.daysToPeak)),
  );
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "12 Aug", for the peak line on a radiant's label and info card. */
export function calendarDayLabel([month, day]: CalendarDay): string {
  return `${day} ${MONTH_NAMES[month - 1] ?? '?'}`;
}
