import { NextResponse } from "next/server";
import {
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  radiansToDegrees,
  type OMMJsonObject,
  type SatRec,
} from "satellite.js";

const DEFAULT_GROUP = "active";
const REQUEST_TIMEOUT_MS = 25000;
const ORBIT_CACHE_TTL_MS = 30 * 60 * 1000;
const POSITION_CACHE_TTL_MS = 5000;

const ALLOWED_GROUPS = new Set(["active", "stations", "starlink"]);

type CachedOrbitRecord = {
  countryCode: string | null;
  inclination: number | null;
  launchDate: string | null;
  noradId: number;
  objectName: string;
  objectType: string | null;
  satrec: SatRec;
};

type CachedOrbitSet = {
  fetchedAt: string;
  records: CachedOrbitRecord[];
  source: string;
};

type SatellitePosition = {
  altitudeKm: number;
  countryCode: string | null;
  inclination: number | null;
  launchDate: string | null;
  lat: number;
  lon: number;
  noradId: number;
  objectName: string;
  objectType: string | null;
  speedKps: number;
};

const orbitCache = new Map<string, { expiresAt: number; value: CachedOrbitSet }>();
const positionCache = new Map<
  string,
  {
    expiresAt: number;
    value: {
      computedAt: string;
      count: number;
      fetchedAt: string;
      group: string;
      satellites: SatellitePosition[];
      source: string;
      totalOrbits: number;
    };
  }
>();

export const dynamic = "force-dynamic";
export const revalidate = 0;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function toCleanString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildGroupFeedUrl(group: string): string {
  return `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
}

function normalizeLongitude(lon: number): number {
  if (!Number.isFinite(lon)) {
    return lon;
  }

  if (lon > 180) {
    return lon - 360;
  }

  if (lon < -180) {
    return lon + 360;
  }

  return lon;
}

function normalizeObjectType(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const upperValue = value.trim().toUpperCase();

  if (upperValue === "PAY" || upperValue === "PAYLOAD") {
    return "PAYLOAD";
  }

  if (upperValue === "DEB" || upperValue === "DEBRIS") {
    return "DEBRIS";
  }

  if (upperValue === "R/B" || upperValue === "ROCKET BODY" || upperValue === "RB") {
    return "ROCKET BODY";
  }

  return upperValue;
}

function inferObjectTypeFromName(objectName: string): string {
  const upperName = objectName.toUpperCase();

  if (upperName.includes(" DEB") || upperName.includes("DEBRIS")) {
    return "DEBRIS";
  }

  if (upperName.includes(" R/B") || upperName.includes("ROCKET BODY")) {
    return "ROCKET BODY";
  }

  return "PAYLOAD";
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadOrbitSet(group: string): Promise<CachedOrbitSet> {
  const now = Date.now();
  const cached = orbitCache.get(group);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const source = buildGroupFeedUrl(group);
  const response = await fetchWithTimeout(source, REQUEST_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`CelesTrak orbit request failed (${response.status})`);
  }

  const payload = (await response.json()) as OMMJsonObject[];
  const records: CachedOrbitRecord[] = [];

  for (const entry of payload) {
    const noradId = toFiniteNumber(entry.NORAD_CAT_ID);
    if (noradId === null) {
      continue;
    }

    try {
      const objectName = toCleanString(entry.OBJECT_NAME) ?? `NORAD-${noradId}`;
      const objectType =
        normalizeObjectType(toCleanString(entry.OBJECT_TYPE)) ??
        inferObjectTypeFromName(objectName);

      records.push({
        countryCode: toCleanString(entry.COUNTRY_CODE),
        inclination: toFiniteNumber(entry.INCLINATION),
        launchDate: toCleanString(entry.LAUNCH_DATE),
        noradId,
        objectName,
        objectType,
        satrec: json2satrec(entry),
      });
    } catch {
      continue;
    }
  }

  const value = {
    fetchedAt: new Date().toISOString(),
    records,
    source,
  };

  orbitCache.set(group, {
    expiresAt: now + ORBIT_CACHE_TTL_MS,
    value,
  });

  return value;
}

function computePositions(
  records: CachedOrbitRecord[],
  nowDate: Date,
  limit: number | null,
): SatellitePosition[] {
  const gmst = gstime(nowDate);
  const requestedCount =
    limit === null ? records.length : Math.min(records.length, limit);
  const satellites: SatellitePosition[] = [];

  for (let index = 0; index < requestedCount; index += 1) {
    const record = records[index];
    const state = propagate(record.satrec, nowDate);

    if (!state || !state.position || !state.velocity) {
      continue;
    }

    const geodetic = eciToGeodetic(state.position, gmst);
    const lat = radiansToDegrees(geodetic.latitude);
    const lon = normalizeLongitude(radiansToDegrees(geodetic.longitude));

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }

    const speedKps = Math.sqrt(
      state.velocity.x * state.velocity.x +
        state.velocity.y * state.velocity.y +
        state.velocity.z * state.velocity.z,
    );

    satellites.push({
      altitudeKm: Number(geodetic.height.toFixed(2)),
      countryCode: record.countryCode,
      inclination: record.inclination,
      launchDate: record.launchDate,
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
      noradId: record.noradId,
      objectName: record.objectName,
      objectType: record.objectType,
      speedKps: Number(speedKps.toFixed(3)),
    });
  }

  return satellites;
}

function parseLimit(limitParam: string | null): number | null {
  if (!limitParam) {
    return null;
  }

  const parsed = Number(limitParam);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestedGroup = (url.searchParams.get("group") ?? DEFAULT_GROUP).toLowerCase();
    const group = ALLOWED_GROUPS.has(requestedGroup)
      ? requestedGroup
      : DEFAULT_GROUP;
    const limit = parseLimit(url.searchParams.get("limit"));

    const positionCacheKey = `${group}:${limit ?? "all"}`;
    const now = Date.now();
    const cachedPositions = positionCache.get(positionCacheKey);

    if (cachedPositions && cachedPositions.expiresAt > now) {
      return NextResponse.json(cachedPositions.value, {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        },
      });
    }

    const orbitSet = await loadOrbitSet(group);
    const computedAt = new Date().toISOString();
    const satellites = computePositions(orbitSet.records, new Date(computedAt), limit);

    const value = {
      computedAt,
      count: satellites.length,
      fetchedAt: orbitSet.fetchedAt,
      group,
      satellites,
      source: orbitSet.source,
      totalOrbits: orbitSet.records.length,
    };

    positionCache.set(positionCacheKey, {
      expiresAt: now + POSITION_CACHE_TTL_MS,
      value,
    });

    return NextResponse.json(value, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown failure while computing satellite positions";

    return NextResponse.json(
      { error: `Unable to fetch live satellite positions: ${message}` },
      { status: 502 },
    );
  }
}
