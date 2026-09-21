/**
 * StarGaze core: on-device astronomy.
 *
 * Sensors and a clock in, screen positions out. No DOM, no network, no state --
 * every function here is pure, which is why the whole thing is testable against
 * JPL without a browser anywhere in sight.
 *
 * The chain, once per frame:
 *
 *   1. `julianDate(new Date())`         -- when
 *   2. `localSiderealTime(jd, lon)`     -- which part of the sky is overhead
 *   3. `toHorizontal(...)`              -- catalogue into the observer's sky
 *   4. `basisFrom...(sensors)`          -- where the phone is pointed
 *   5. `project(...)`                   -- sky onto the screen
 *
 * Steps 1-3 change slowly and belong on a timer; 4 and 5 run every frame.
 */

export * from './angles.js';
export * from './time.js';
export * from './timetravel.js';
export * from './coords.js';
export * from './apparent.js';
export * from './catalog.js';
export * from './deepsky.js';
export * from './planets.js';
export * from './asteroids.js';
export * from './showers.js';
export * from './moon.js';
export * from './declination.js';
export * from './orientation.js';
export * from './projection.js';
export * from './visibility.js';
