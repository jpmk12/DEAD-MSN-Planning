// Shared domain types for the analysis engine.
//
// Convention notes (these matter for correctness):
//  - All headings are in degrees.
//  - `magVar` is signed, EAST-positive (e.g. +13 in California, -9 near
//    Charleston SC). True = Magnetic + magVar.  ("East is least, west is best"
//    when going the other way: Magnetic = True - magVar.)
//  - METAR/observed wind direction is referenced to TRUE north (ICAO/WMO).
//    Tower/ATIS spoken winds are magnetic; we always work in TRUE internally.

export interface RunwayEnd {
  /** Designator, e.g. "15", "33L". */
  ident: string;
  /** Surveyed MAGNETIC heading of the runway centerline, degrees. */
  magHeading: number;
  lengthFt?: number;
  widthFt?: number;
  surface?: string;
  /** Pattern direction flown to this runway, if non-standard. */
  trafficPattern?: 'left' | 'right';
}

export interface Airport {
  icao: string;
  name: string;
  elevationFt: number;
  /** Magnetic variation, EAST-positive. */
  magVar: number;
  runways: RunwayEnd[];
  /**
   * Provenance of this record. "curated" = hand-entered illustrative data;
   * replace with "nasr" / "openaip" once authoritative ingest is wired in.
   */
  source?: 'curated' | 'nasr' | 'openaip';
}

export interface WindObs {
  /** Wind direction in TRUE degrees, or 'VRB' for variable, or null if calm/missing. */
  dirTrue: number | 'VRB' | null;
  speedKt: number;
  gustKt?: number | null;
}

export interface Observation {
  icao: string;
  /** ISO timestamp of the observation, if known. */
  obsTime?: string;
  wind: WindObs;
  tempC?: number | null;
  /** Altimeter setting / QNH in hectopascals (mb). */
  altimHpa?: number | null;
  rawText?: string;
}

/** Operating limits — user-configurable placeholders, NOT official -1/TO values. */
export interface AircraftLimits {
  crosswindKt: number;
  tailwindKt: number;
  /** Optional: warn when density altitude climbs above this. */
  highDensityAltitudeFt?: number;
}

export interface RunwayWind {
  ident: string;
  magHeading: number;
  trueHeading: number;
  /** Positive = headwind, negative = tailwind. */
  headwindKt: number;
  /** Magnitude of the crosswind component. */
  crosswindKt: number;
  crosswindSide: 'left' | 'right' | 'none';
  isTailwind: boolean;
  /** Same, computed against the gust value (only if a gust was reported). */
  gustHeadwindKt?: number;
  gustCrosswindKt?: number;
}

export interface AirfieldAnalysis {
  airport: Airport;
  observation: Observation;
  runways: RunwayWind[];
  /** Best runway for the reported wind, or null if wind is calm/variable. */
  active: RunwayWind | null;
  windIndeterminate: boolean;
  pressureAltitudeFt: number | null;
  densityAltitudeFt: number | null;
  isaDeviationC: number | null;
  warnings: string[];
}
