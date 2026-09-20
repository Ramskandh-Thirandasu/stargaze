/**
 * Loading the generated catalogues.
 *
 * Six small JSON files, ~58 KB gzipped between them. They are fetched once and
 * parsed into typed arrays; after that the app never touches the network again,
 * which is the point -- it is used in fields, not on wifi.
 */

import {
  parseDeclinationGrid,
  parseDeepSky,
  parseStarCatalog,
  parseStarNames,
  resolveConstellations,
  type ConstellationFigures,
  type ConstellationJson,
  type DeclinationGrid,
  type DeclinationGridJson,
  type DeepSkyJson,
  type DeepSkyObject,
  type PlanetTable,
  type StarCatalog,
  type StarCatalogJson,
  type StarName,
  type StarNamesJson,
} from '@stargaze/core';

export interface SkyData {
  stars: StarCatalog;
  names: Map<number, StarName>;
  figures: ConstellationFigures;
  planets: PlanetTable;
  declination: DeclinationGrid;
  deepSky: DeepSkyObject[];
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`${path}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function loadSkyData(base = './data'): Promise<SkyData> {
  const [starsJson, namesJson, constellationsJson, planets, declinationJson, deepSkyJson] =
    await Promise.all([
      json<StarCatalogJson>(`${base}/stars.json`),
      json<StarNamesJson>(`${base}/names.json`),
      json<ConstellationJson>(`${base}/constellations.json`),
      json<PlanetTable>(`${base}/planets.json`),
      json<DeclinationGridJson>(`${base}/declination.json`),
      json<DeepSkyJson>(`${base}/deepsky.json`),
    ]);

  const stars = parseStarCatalog(starsJson);

  return {
    stars,
    names: parseStarNames(namesJson),
    figures: resolveConstellations(constellationsJson, stars),
    planets,
    declination: parseDeclinationGrid(declinationJson),
    deepSky: parseDeepSky(deepSkyJson),
  };
}

/** Display name for a star, falling back through its designations. */
export function starLabel(hip: number, names: Map<number, StarName>): string {
  const entry = names.get(hip);
  if (!entry) return `HIP ${hip}`;
  if (entry.proper) return entry.proper;
  if (entry.bayer && entry.constellation) return `${entry.bayer} ${entry.constellation}`;
  if (entry.flamsteed && entry.constellation) return `${entry.flamsteed} ${entry.constellation}`;
  return `HIP ${hip}`;
}
