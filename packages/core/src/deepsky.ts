/**
 * The Messier catalogue: galaxies, nebulae and clusters.
 *
 * Plain objects rather than the typed parallel arrays the star catalogue uses.
 * That trade is about volume -- nine thousand stars are transformed in one
 * pass per sky update and want contiguous buffers, whereas this is a few dozen
 * entries carrying strings, where the array-of-structs is both cheaper to read
 * and cheaper to write.
 *
 * The JSON still ships as parallel arrays, because the header-plus-columns
 * shape is what the rest of the generated data uses and it gzips better.
 */

/** The generated `deepsky.json`, as it arrives from the network. */
export interface DeepSkyJson {
  epoch: string;
  magLimit: number;
  count: number;
  source: string;
  /** Messier numbers, 1-110. */
  m: number[];
  /** NGC numbers; 0 where the object has none. */
  ngc: number[];
  /** Common names; "" where the object has none. */
  name: string[];
  type: string[];
  ra: number[];
  dec: number[];
  mag: number[];
  /** Apparent size along the long and short axes, arcminutes. */
  major: number[];
  minor: number[];
}

/**
 * What kind of thing it is, in the words someone would actually use.
 *
 * Coarser than the source catalogue on purpose -- see OPENNGC_TYPES in
 * tools/sources.py for what gets collapsed into what.
 */
export type DeepSkyType = 'galaxy' | 'globular' | 'cluster' | 'nebula' | 'planetary' | 'star';

/** Human-readable form of {@link DeepSkyType}, for labels and info cards. */
export const DEEP_SKY_TYPE_NAMES: Record<DeepSkyType, string> = {
  galaxy: 'Galaxy',
  globular: 'Globular cluster',
  cluster: 'Star cluster',
  nebula: 'Nebula',
  planetary: 'Planetary nebula',
  star: 'Stars',
};

/** One deep-sky object, J2000. */
export interface DeepSkyObject {
  /** Messier number. */
  messier: number;
  /** NGC number, absent for the handful that never got one. */
  ngc?: number;
  /** Common name, e.g. "Andromeda Galaxy". Absent for most of them. */
  name?: string;
  type: DeepSkyType;
  /** J2000 right ascension, degrees. */
  ra: number;
  /** J2000 declination, degrees. */
  dec: number;
  /** Integrated visual magnitude. */
  mag: number;
  /** Apparent size along the long axis, degrees. */
  major: number;
  /** Apparent size along the short axis, degrees. Equal to `major` when round. */
  minor: number;
}

/** arcminutes to degrees -- the source quotes sizes in the former, the
 *  projection wants the latter. */
const ARCMIN_TO_DEG = 1 / 60;

/**
 * Parse the generated catalogue. Sorted brightest first, as generated.
 *
 * An unrecognised type falls back to 'nebula' rather than throwing: a new
 * classification appearing upstream should mean a slightly wrong word on an
 * info card, not a sky that refuses to load.
 */
export function parseDeepSky(json: DeepSkyJson): DeepSkyObject[] {
  const objects: DeepSkyObject[] = [];

  for (let i = 0; i < json.count; i += 1) {
    const ngc = json.ngc[i] as number;
    const name = json.name[i] as string;
    const type = json.type[i] as DeepSkyType;

    objects.push({
      messier: json.m[i] as number,
      ...(ngc ? { ngc } : {}),
      ...(name ? { name } : {}),
      type: type in DEEP_SKY_TYPE_NAMES ? type : 'nebula',
      ra: json.ra[i] as number,
      dec: json.dec[i] as number,
      mag: json.mag[i] as number,
      major: (json.major[i] as number) * ARCMIN_TO_DEG,
      minor: (json.minor[i] as number) * ARCMIN_TO_DEG,
    });
  }

  return objects;
}

/**
 * What to call it on screen.
 *
 * The common name when it has one, because "Andromeda Galaxy" beats "M31" for
 * everyone who is not already an amateur astronomer, and the Messier number
 * otherwise. The full designation is a separate line -- see
 * {@link deepSkyDesignation}.
 */
export function deepSkyLabel(object: DeepSkyObject): string {
  return object.name ?? `M${object.messier}`;
}

/** Every catalogue number the object has, for the info card and for search. */
export function deepSkyDesignation(object: DeepSkyObject): string {
  return object.ngc ? `M${object.messier} · NGC ${object.ngc}` : `M${object.messier}`;
}
