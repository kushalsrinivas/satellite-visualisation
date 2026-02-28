"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GlobeMethods } from "react-globe.gl";

const Globe = dynamic(() => import("react-globe.gl"), {
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-slate-950 text-slate-200">
      Loading 3D globe...
    </div>
  ),
  ssr: false,
});

type Satellite = {
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

type SatellitesApiResponse = {
  computedAt: string;
  group: string;
  satellites: Satellite[];
  totalOrbits: number;
};

type FeedStatus = "live" | "degraded";
type SatelliteGroup = "active" | "stations" | "starlink";
type SatelliteBucket = "payload" | "debris" | "rocket" | "other";

type SatellitePoint = Satellite & {
  bucket: SatelliteBucket;
  color: string;
  lng: number;
  pointAltitude: number;
};

type TransitionState = {
  durationMs: number;
  from: Map<number, SatellitePoint>;
  startMs: number;
  to: Map<number, SatellitePoint>;
};

const GROUP_LABELS: Record<SatelliteGroup, string> = {
  active: "All Active",
  starlink: "Starlink",
  stations: "Stations",
};

const EARTH_RADIUS_KM = 6371;
const REFRESH_INTERVAL_MS = 10000;
const MOTION_DURATION_MS = 8500;
const PAYLOAD_COLOR = "#fde047";
const DEBRIS_COLOR = "#fb7185";
const ROCKET_COLOR = "#a78bfa";
const OTHER_COLOR = "#cbd5e1";

function normalizeLongitude(lon: number): number {
  if (lon > 180) {
    return lon - 360;
  }

  if (lon < -180) {
    return lon + 360;
  }

  return lon;
}

function easeInOutCubic(value: number): number {
  if (value < 0.5) {
    return 4 * value * value * value;
  }

  return 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function longitudeDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function getSatelliteBucket(objectType: string | null): SatelliteBucket {
  if (!objectType) {
    return "other";
  }

  const upperType = objectType.toUpperCase();

  if (upperType === "PAYLOAD" || upperType === "PAY") {
    return "payload";
  }

  if (upperType.includes("DEBRIS") || upperType === "DEB") {
    return "debris";
  }

  if (
    upperType.includes("ROCKET") ||
    upperType === "R/B" ||
    upperType === "RB" ||
    upperType.includes("R/B")
  ) {
    return "rocket";
  }

  return "other";
}

function bucketColor(bucket: SatelliteBucket): string {
  if (bucket === "payload") {
    return PAYLOAD_COLOR;
  }

  if (bucket === "debris") {
    return DEBRIS_COLOR;
  }

  if (bucket === "rocket") {
    return ROCKET_COLOR;
  }

  return OTHER_COLOR;
}

function makeSatellitePoint(satellite: Satellite): SatellitePoint {
  const bucket = getSatelliteBucket(satellite.objectType);

  return {
    ...satellite,
    bucket,
    color: bucketColor(bucket),
    lng: normalizeLongitude(satellite.lon),
    pointAltitude: Math.max(0.0015, satellite.altitudeKm / EARTH_RADIUS_KM),
  };
}

function formatDate(dateText: string | null): string {
  if (!dateText) {
    return "Unknown";
  }

  return new Date(dateText).toLocaleDateString();
}

export default function SatelliteGlobe() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const transitionRef = useRef<TransitionState | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const renderedMapRef = useRef<Map<number, SatellitePoint>>(new Map());

  const [group, setGroup] = useState<SatelliteGroup>("active");
  const [renderedSatellites, setRenderedSatellites] = useState<SatellitePoint[]>([]);
  const [status, setStatus] = useState<FeedStatus>("live");
  const [lastComputedAt, setLastComputedAt] = useState<string | null>(null);
  const [totalOrbits, setTotalOrbits] = useState<number>(0);
  const [size, setSize] = useState({ height: 0, width: 0 });
  const [hovered, setHovered] = useState<SatellitePoint | null>(null);
  const [selected, setSelected] = useState<SatellitePoint | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      setSize({
        height: Math.max(1, Math.floor(entry.contentRect.height)),
        width: Math.max(1, Math.floor(entry.contentRect.width)),
      });
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const controls = globeRef.current?.controls();
    if (!controls) {
      return;
    }

    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.12;
    controls.enablePan = false;
    controls.minDistance = 140;
    controls.maxDistance = 1000;
    globeRef.current?.pointOfView({ altitude: 4.1 }, 0);
  }, [size.height, size.width]);

  const animateStep = useCallback((frameTimeMs: number) => {
    const transition = transitionRef.current;

    if (!transition) {
      animationFrameRef.current = null;
      return;
    }

    const progress = Math.min(
      1,
      (frameTimeMs - transition.startMs) / transition.durationMs,
    );
    const eased = easeInOutCubic(progress);
    const nextMap = new Map<number, SatellitePoint>();
    const nextList: SatellitePoint[] = [];

    for (const [noradId, target] of transition.to.entries()) {
      const from = transition.from.get(noradId) ?? target;
      const nextLat = from.lat + (target.lat - from.lat) * eased;
      const nextLng = normalizeLongitude(
        from.lng + longitudeDelta(from.lng, target.lng) * eased,
      );
      const nextAltitudeKm =
        from.altitudeKm + (target.altitudeKm - from.altitudeKm) * eased;

      const point: SatellitePoint = {
        ...target,
        altitudeKm: nextAltitudeKm,
        lat: nextLat,
        lng: nextLng,
        pointAltitude: Math.max(0.0015, nextAltitudeKm / EARTH_RADIUS_KM),
      };

      nextMap.set(noradId, point);
      nextList.push(point);
    }

    renderedMapRef.current = nextMap;
    setRenderedSatellites(nextList);

    if (progress < 1) {
      animationFrameRef.current = window.requestAnimationFrame(animateStep);
      return;
    }

    transitionRef.current = null;
    animationFrameRef.current = null;
  }, []);

  const startTransition = useCallback(
    (incomingSatellites: Satellite[]) => {
      const targetMap = new Map<number, SatellitePoint>();

      for (const satellite of incomingSatellites) {
        targetMap.set(satellite.noradId, makeSatellitePoint(satellite));
      }

      if (renderedMapRef.current.size === 0) {
        const initialList = [...targetMap.values()];
        renderedMapRef.current = targetMap;
        setRenderedSatellites(initialList);
        return;
      }

      const fromMap = new Map<number, SatellitePoint>();
      for (const [noradId, target] of targetMap.entries()) {
        fromMap.set(noradId, renderedMapRef.current.get(noradId) ?? target);
      }

      transitionRef.current = {
        durationMs: MOTION_DURATION_MS,
        from: fromMap,
        startMs: performance.now(),
        to: targetMap,
      };

      if (animationFrameRef.current === null) {
        animationFrameRef.current = window.requestAnimationFrame(animateStep);
      }
    },
    [animateStep],
  );

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    let isRequestInFlight = false;

    const fetchSatellites = async () => {
      if (isRequestInFlight) {
        return;
      }

      isRequestInFlight = true;

      try {
        const response = await fetch(`/api/satellites?group=${group}`, {
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`Satellite feed request failed (${response.status})`);
        }

        const payload = (await response.json()) as SatellitesApiResponse;

        if (!isActive) {
          return;
        }

        startTransition(payload.satellites);
        setTotalOrbits(payload.totalOrbits);
        setLastComputedAt(payload.computedAt);
        setStatus("live");
      } catch {
        if (!isActive) {
          return;
        }

        setStatus("degraded");
      } finally {
        isRequestInFlight = false;
      }
    };

    void fetchSatellites();

    const intervalId = window.setInterval(() => {
      void fetchSatellites();
    }, REFRESH_INTERVAL_MS);

    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [group, startTransition]);

  const particleGroups = useMemo(() => {
    const groups: Record<SatelliteBucket, SatellitePoint[]> = {
      debris: [],
      other: [],
      payload: [],
      rocket: [],
    };

    for (const satellite of renderedSatellites) {
      groups[satellite.bucket].push(satellite);
    }

    return [
      groups.payload,
      groups.debris,
      groups.rocket,
      groups.other,
    ].filter((groupList) => groupList.length > 0);
  }, [renderedSatellites]);

  const focusedSatellite = selected ?? hovered;
  const lastUpdatedLabel = lastComputedAt
    ? new Date(lastComputedAt).toLocaleTimeString()
    : "Waiting for first update";

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full bg-[radial-gradient(circle_at_20%_20%,#14213d_0%,#020617_52%,#000000_100%)]"
    >
      <Globe
        ref={globeRef}
        animateIn={false}
        backgroundColor="rgba(0,0,0,0)"
        backgroundImageUrl="/textures/night-sky.png"
        globeImageUrl="/textures/earth-blue-marble.jpg"
        height={size.height}
        labelsTransitionDuration={0}
        onParticleClick={(particle) => {
          setSelected((particle as SatellitePoint | null) ?? null);
        }}
        onParticleHover={(particle) => {
          setHovered((particle as SatellitePoint | null) ?? null);
        }}
        particleAltitude="pointAltitude"
        particleLabel={(particle) => {
          const satellite = particle as SatellitePoint;
          return `
            <div style="padding:6px 8px;background:#020617d9;border:1px solid #1e293b;border-radius:8px;color:#e2e8f0;font-size:12px;line-height:1.45;">
              <div style="font-weight:600;margin-bottom:2px;">${satellite.objectName}</div>
              <div>NORAD: ${satellite.noradId}</div>
              <div>Type: ${satellite.objectType ?? "Unknown"}</div>
              <div>Altitude: ${satellite.altitudeKm.toFixed(1)} km</div>
              <div>Speed: ${satellite.speedKps.toFixed(2)} km/s</div>
            </div>
          `;
        }}
        particleLat="lat"
        particleLng="lng"
        particlesColor={(groupList) => {
          const group = groupList as SatellitePoint[];
          return group[0]?.color ?? OTHER_COLOR;
        }}
        particlesData={particleGroups}
        particlesList={(groupList) => groupList as SatellitePoint[]}
        particlesSize={1}
        particlesSizeAttenuation
        width={size.width}
      />

      <div className="pointer-events-none absolute left-4 top-4 rounded-md bg-slate-950/75 px-3 py-2 text-xs text-white shadow-lg backdrop-blur">
        <p className="text-sm font-semibold tracking-wide">Live Satellite Globe</p>
        <p className={status === "live" ? "text-emerald-300" : "text-amber-300"}>
          Status: {status === "live" ? "Online" : "Degraded"}
        </p>
        <p className="text-slate-300">
          Group: {GROUP_LABELS[group]} ({renderedSatellites.length.toLocaleString()} visible)
        </p>
        <p className="text-slate-300">Orbit Records: {totalOrbits.toLocaleString()}</p>
        <p className="text-slate-300">Refresh: every 10s</p>
        <p className="text-slate-400">Motion: smooth interpolation</p>
        <p className="text-slate-400">Last Update: {lastUpdatedLabel}</p>
      </div>

      <div className="absolute right-4 top-4 z-[460] grid grid-cols-3 gap-1 rounded-md bg-slate-950/75 p-2 shadow-lg backdrop-blur">
        {(["active", "stations", "starlink"] as SatelliteGroup[]).map((option) => (
          <button
            key={option}
            className={`cursor-pointer rounded px-2 py-1 text-[11px] ${
              option === group
                ? "bg-sky-600 text-white"
                : "bg-slate-800 text-slate-200"
            }`}
            onClick={() => setGroup(option)}
            type="button"
          >
            {GROUP_LABELS[option]}
          </button>
        ))}
      </div>

      <div className="pointer-events-none absolute bottom-4 right-4 rounded-md bg-slate-950/75 p-3 text-xs text-white shadow-lg backdrop-blur">
        <p className="mb-2 font-semibold tracking-wide">Legend</p>
        <div className="flex items-center gap-2 text-slate-200">
          <span className="inline-block h-2 w-2 rounded-full bg-[#fde047]" />
          Payload
        </div>
        <div className="mt-1 flex items-center gap-2 text-slate-200">
          <span className="inline-block h-2 w-2 rounded-full bg-[#fb7185]" />
          Debris
        </div>
        <div className="mt-1 flex items-center gap-2 text-slate-200">
          <span className="inline-block h-2 w-2 rounded-full bg-[#a78bfa]" />
          Rocket Body
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-4 left-4 w-72 rounded-md bg-slate-950/75 p-3 text-xs text-white shadow-lg backdrop-blur">
        <p className="mb-2 font-semibold tracking-wide">Satellite Focus</p>
        {focusedSatellite ? (
          <div className="space-y-1 text-slate-200">
            <p className="text-sm font-medium text-white">{focusedSatellite.objectName}</p>
            <p>NORAD ID: {focusedSatellite.noradId}</p>
            <p>Type: {focusedSatellite.objectType ?? "Unknown"}</p>
            <p>Altitude: {focusedSatellite.altitudeKm.toFixed(2)} km</p>
            <p>Speed: {focusedSatellite.speedKps.toFixed(3)} km/s</p>
            <p>
              Position: {focusedSatellite.lat.toFixed(2)} lat,{" "}
              {focusedSatellite.lng.toFixed(2)} lon
            </p>
            <p>Inclination: {focusedSatellite.inclination?.toFixed(2) ?? "Unknown"} deg</p>
            <p>Launch Date: {formatDate(focusedSatellite.launchDate)}</p>
            <p>Country: {focusedSatellite.countryCode ?? "Unknown"}</p>
          </div>
        ) : (
          <p className="text-slate-300">
            Hover or click a satellite on the globe to inspect altitude and orbital info.
          </p>
        )}
      </div>
    </div>
  );
}
