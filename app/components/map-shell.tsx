"use client";

import dynamic from "next/dynamic";

const SatelliteGlobe = dynamic(() => import("./satellite-globe"), {
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-slate-950 text-slate-200">
      Loading globe...
    </div>
  ),
  ssr: false,
});

export default function MapShell() {
  return <SatelliteGlobe />;
}
