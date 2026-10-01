import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  APIProvider,
  AdvancedMarker,
  Map,
  Polyline,
  useMap,
} from "@vis.gl/react-google-maps";
import { io } from "socket.io-client";

const ORDER_ID = "ord_123";
const DRIVER_ID = "drv_9";
const API_ORIGIN = "http://localhost:3000";
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
const MAP_ID = "DEMO_MAP_ID";

const INTERVAL_MS = 2000;
const STEP_METERS = 20;
const SLIDE_MS = 2000;
const SNAP_METERS = 80;

export type LatLng = { lat: number; lng: number };

export interface LocationItem extends LatLng {
  name: string;
  address?: string;
}

export interface PlaceSearchResult {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

const DEFAULT_SOURCE: LocationItem = {
  lat: 21.2439414,
  lng: 81.6076675,
  name: "Pizza Hut, GE Road",
  address: "GE Road, Raipur, Chhattisgarh",
};

const DEFAULT_DESTINATION: LocationItem = {
  lat: 21.2392,
  lng: 81.6518,
  name: "Civil Lines",
  address: "Civil Lines, Raipur, Chhattisgarh",
};

function metersBetween(a: LatLng, b: LatLng): number {
  const earth = 6371000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(from: LatLng, to: LatLng): number {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function metersToSegment(
  p: LatLng,
  a: LatLng,
  b: LatLng,
): { meters: number; along: number } {
  const length = metersBetween(a, b);
  if (length < 0.5) return { meters: metersBetween(p, a), along: 0 };
  const cosLat = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const dx = (b.lng - a.lng) * cosLat;
  const dy = b.lat - a.lat;
  const px = (p.lng - a.lng) * cosLat;
  const py = p.lat - a.lat;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / l2));
  const proj = {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
  return { meters: metersBetween(p, proj), along: t * length };
}

function projectOntoRoute(
  route: LatLng[],
  position: LatLng,
  fromIndex = 0,
): { segment: number; into: number; covered: number } | null {
  if (route.length < 2) return null;
  const start = Math.max(0, Math.min(fromIndex, route.length - 2));
  let best: { segment: number; into: number; meters: number } | null = null;
  for (let i = start; i < route.length - 1; i++) {
    const hit = metersToSegment(position, route[i], route[i + 1]);
    if (!best || hit.meters < best.meters) {
      best = { segment: i, into: hit.along, meters: hit.meters };
    }
  }
  if (!best || best.meters > SNAP_METERS) return null;
  return {
    segment: best.segment,
    into: best.into,
    covered: calculateCoveredDistance(route, best.segment, best.into),
  };
}

function getRemainingRoute(
  route: LatLng[],
  position: LatLng | null,
  fromIndex: number,
): { path: LatLng[]; index: number } {
  if (!position || route.length < 2) return { path: route, index: 0 };
  const nearStart = metersBetween(position, route[0]) < 40;
  const start = nearStart ? 0 : Math.max(0, Math.min(fromIndex, route.length - 2) - 2);
  let bestIndex = start;
  let bestMeters = Infinity;
  for (let i = start; i < route.length - 1; i++) {
    const hit = metersToSegment(position, route[i], route[i + 1]);
    if (hit.meters < bestMeters) {
      bestMeters = hit.meters;
      bestIndex = i;
    }
  }
  if (bestMeters > SNAP_METERS) {
    const keep = Math.max(0, Math.min(fromIndex, route.length - 2));
    return { path: [position, ...route.slice(keep + 1)], index: keep };
  }
  return { path: [position, ...route.slice(bestIndex + 1)], index: bestIndex };
}

function getNextRoutePosition(
  route: LatLng[],
  currentSegment: number,
  currentInto: number,
  stepMeters = STEP_METERS
): { pos: LatLng; segment: number; into: number; arrived: boolean } {
  if (route.length < 2) {
    return { pos: route[0] || DEFAULT_SOURCE, segment: 0, into: 0, arrived: true };
  }

  let segment = currentSegment;
  let into = currentInto;
  let left = stepMeters;

  while (left > 0 && segment < route.length - 1) {
    const start = route[segment];
    const end = route[segment + 1];
    const length = metersBetween(start, end);
    if (length < 0.5) {
      segment += 1;
      into = 0;
      continue;
    }

    const remain = length - into;
    if (left <= remain) {
      into += left;
      const t = into / length;
      const pos = {
        lat: start.lat + (end.lat - start.lat) * t,
        lng: start.lng + (end.lng - start.lng) * t,
      };
      return { pos, segment, into, arrived: false };
    }

    left -= remain;
    segment += 1;
    into = 0;
  }

  return {
    pos: route[route.length - 1],
    segment: route.length - 1,
    into: 0,
    arrived: true,
  };
}

function calculateRouteDistance(route: LatLng[]): number {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    total += metersBetween(route[i], route[i + 1]);
  }
  return total;
}

function calculateCoveredDistance(route: LatLng[], segment: number, into: number): number {
  let covered = 0;
  for (let i = 0; i < segment && i < route.length - 1; i++) {
    covered += metersBetween(route[i], route[i + 1]);
  }
  covered += into;
  return covered;
}

async function searchPlaces(query: string, center?: LatLng): Promise<PlaceSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const biasParams = center ? `&lat=${center.lat}&lon=${center.lng}` : "";
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(trimmed)}${biasParams}&limit=8`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Search API error");
    const data = await res.json();
    const results: PlaceSearchResult[] = (data.features || []).map((f: {
      properties?: {
        name?: string;
        street?: string;
        district?: string;
        suburb?: string;
        city?: string;
        state?: string;
        country?: string;
        osm_id?: number | string;
      };
      geometry?: { coordinates?: [number, number] };
    }, idx: number) => {
      const p = f.properties || {};
      const parts = [p.street, p.district || p.suburb, p.city, p.state].filter(Boolean);
      const name = p.name || p.street || trimmed;
      const address = parts.join(", ") || p.country || "";
      const coords = f.geometry?.coordinates || [0, 0];
      return {
        id: `${p.osm_id || idx}-${name}`,
        name,
        address,
        lat: coords[1],
        lng: coords[0],
      };
    });

    if (center && results.length > 1) {
      results.sort((a, b) => metersBetween(a, center) - metersBetween(b, center));
    }
    return results;
  } catch {
    try {
      const nomUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(trimmed)}&limit=6`;
      const nomRes = await fetch(nomUrl, { headers: { "User-Agent": "LiveDeliveryTracking/1.0" } });
      const nomData = await nomRes.json();
      return (nomData || []).map((item: { place_id?: number; name?: string; display_name: string; lat: string; lon: string }, idx: number) => ({
        id: `nom-${item.place_id || idx}`,
        name: item.name || item.display_name.split(",")[0],
        address: item.display_name,
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
      }));
    } catch {
      return [];
    }
  }
}

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`,
      { headers: { "User-Agent": "LiveDeliveryTracking/1.0" } }
    );
    if (!res.ok) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const data = await res.json();
    const parts = (data.display_name || "").split(",");
    return parts.slice(0, 3).join(",").trim() || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

function PlacePin({
  color = "#282c3f",
  glyph,
  label,
}: {
  color?: string;
  glyph: ReactNode;
  label?: string;
}) {
  return (
    <div className="place-pin-wrapper">
      <svg
        className="place-pin"
        viewBox="0 0 42 48"
        width="42"
        height="48"
        aria-hidden="true"
      >
        <path
          d="M21 46.5L16.2 38.2C10.5 35 6.5 28.8 6.5 21.5C6.5 12.4 13 5 21 5C29 5 35.5 12.4 35.5 21.5C35.5 28.8 31.5 35 25.8 38.2L21 46.5Z"
          fill={color}
          stroke="#ffffff"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        {glyph}
      </svg>
      <div className="pin-shadow-dot" />
      {label ? <div className="place-pin-label">{label}</div> : null}
    </div>
  );
}

const storeGlyph = (
  <>
    <path
      d="M13.5 21.5C13.5 25.6 16.9 29 21 29C25.1 29 28.5 25.6 28.5 21.5H13.5Z"
      fill="#ffffff"
    />
    <path
      d="M17 20L14 14C13.8 13.5 14.2 13 14.8 13.2L18.5 14.8"
      stroke="#ffffff"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <circle cx="20.5" cy="15" r="1.5" fill="#ffffff" />
    <circle cx="25" cy="13.5" r="1.5" fill="#ffffff" />
    <circle cx="27" cy="16.5" r="1.2" fill="#ffffff" />
  </>
);

const homeGlyph = (
  <path
    d="M21 13L13.5 19.5H16V28H20V23C20 22.4 20.4 22 21 22C21.6 22 22 22.4 22 23V28H26V19.5H28.5L21 13Z"
    fill="#ffffff"
  />
);

function DriverGlyph({ heading }: { heading: number }) {
  return (
    <div className="driver-marker">
      <div className="driver-pulse" />
      <div className="driver-rig" style={{ transform: `rotate(${heading}deg)` }}>
        <svg
          className="driver-scooter"
          width="46"
          height="64"
          viewBox="0 0 46 64"
          fill="none"
          aria-hidden="true"
        >
          <ellipse cx="23" cy="33" rx="14" ry="26" fill="rgba(0,0,0,0.22)" />
          <rect x="21" y="3" width="4" height="12" rx="2" fill="#1e293b" />
          <path d="M17 14C17 9.5 29 9.5 29 14L28 22C28 24 18 24 18 22Z" fill="#ea580c" />
          <path d="M20 8.5C20 7 26 7 26 8.5L25.5 11.5L20.5 11.5Z" fill="#ffffff" opacity="0.9" />
          <line x1="8" y1="17" x2="38" y2="17" stroke="#334155" strokeWidth="2.8" strokeLinecap="round" />
          <rect x="6" y="15" width="5.5" height="4" rx="1.5" fill="#0f172a" />
          <rect x="34.5" y="15" width="5.5" height="4" rx="1.5" fill="#0f172a" />
          <circle cx="6" cy="13.5" r="2.2" fill="#475569" stroke="#1e293b" strokeWidth="0.8" />
          <circle cx="40" cy="13.5" r="2.2" fill="#475569" stroke="#1e293b" strokeWidth="0.8" />
          <path d="M15 27.5L9.5 18" stroke="#1e293b" strokeWidth="4.8" strokeLinecap="round" />
          <path d="M31 27.5L36.5 18" stroke="#1e293b" strokeWidth="4.8" strokeLinecap="round" />
          <circle cx="9.5" cy="17" r="2.2" fill="#fdba74" />
          <circle cx="36.5" cy="17" r="2.2" fill="#fdba74" />
          <rect x="15.5" y="26" width="15" height="12" rx="3" fill="#334155" />
          <path d="M14.5 26.5C14.5 22.5 31.5 22.5 31.5 26.5L30 36C30 37 16 37 16 36Z" fill="#ea580c" />
          <circle cx="23" cy="23.5" r="7.2" fill="#fc8019" />
          <path d="M17.5 21.5C19 18.5 27 18.5 28.5 21.5Z" fill="#0f172a" />
          <ellipse cx="23" cy="24.5" rx="3.2" ry="3.8" fill="#ff9839" />
          <rect x="11" y="37" width="24" height="21" rx="4.2" fill="#ea580c" stroke="#c2410c" strokeWidth="1.2" />
          <rect x="13" y="39" width="20" height="17" rx="2.8" fill="#ffffff" />
          <path d="M23 42.5C21 42.5 19.5 44 19.5 46C19.5 48.6 23 51.8 23 51.8C23 51.8 26.5 48.6 26.5 46C26.5 44 25 42.5 23 42.5Z" fill="#fc8019" />
          <circle cx="23" cy="45.8" r="1.3" fill="#ffffff" />
          <rect x="19" y="59" width="8" height="2.6" rx="1.3" fill="#ef4444" />
        </svg>
      </div>
    </div>
  );
}

function MovingDriver({ position, heading }: { position: LatLng; heading: number }) {
  const [shown, setShown] = useState(position);
  const shownRef = useRef(position);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const start = shownRef.current;
    const began = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / SLIDE_MS);
      const next = {
        lat: start.lat + (position.lat - start.lat) * t,
        lng: start.lng + (position.lng - start.lng) * t,
      };
      shownRef.current = next;
      setShown(next);
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [position]);

  return (
    <AdvancedMarker
      position={shown}
      zIndex={1000}
      anchorLeft="-23px"
      anchorTop="-32px"
    >
      <DriverGlyph heading={heading} />
    </AdvancedMarker>
  );
}

function AutoFitBounds({
  source,
  destination,
}: {
  source: LatLng;
  destination: LatLng | null;
}) {
  const map = useMap();
  const lastKey = useRef("");

  useEffect(() => {
    if (!map) return;
    const key = `${source.lat.toFixed(5)},${source.lng.toFixed(5)}_${
      destination ? `${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}` : "none"
    }`;
    if (lastKey.current === key) return;
    lastKey.current = key;

    const bounds = new google.maps.LatLngBounds();
    bounds.extend(source);
    if (destination) {
      bounds.extend(destination);
    }
    const isDesktop = window.innerWidth >= 768;
    map.setOptions({ maxZoom: 16 });
    map.fitBounds(bounds, {
      top: 100,
      right: 60,
      bottom: 60,
      left: isDesktop ? 430 : 60,
    });
    google.maps.event.addListenerOnce(map, "idle", () => {
      map.setOptions({ maxZoom: 21 });
    });
  }, [map, source, destination]);

  return null;
}

function FollowDriver({
  position,
  enabled,
}: {
  position: LatLng | null;
  enabled: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map || !position || !enabled) return;
    const bounds = map.getBounds();
    if (!bounds) {
      map.panTo(position);
      return;
    }
    const northEast = bounds.getNorthEast();
    const southWest = bounds.getSouthWest();
    const latPad = (northEast.lat() - southWest.lat()) * 0.15;
    const lngPad = (northEast.lng() - southWest.lng()) * 0.15;
    const inside =
      position.lat < northEast.lat() - latPad &&
      position.lat > southWest.lat() + latPad &&
      position.lng < northEast.lng() - lngPad &&
      position.lng > southWest.lng() + lngPad;
    if (!inside) map.panTo(position);
  }, [map, position, enabled]);

  return null;
}

function DeliveryMap({
  source,
  destination,
  position,
  heading,
  route,
  onMapClick,
}: {
  source: LocationItem;
  destination: LocationItem | null;
  position: LatLng | null;
  heading: number;
  route: LatLng[];
  onMapClick: (coords: LatLng) => void;
}) {
  const routeCursor = useRef(0);
  const seenRoute = useRef(route);
  if (seenRoute.current !== route) {
    seenRoute.current = route;
    routeCursor.current = 0;
  }
  const remainingRoute = useMemo(() => {
    const next = getRemainingRoute(route, position, routeCursor.current);
    routeCursor.current = next.index;
    return next.path;
  }, [route, position]);

  return (
    <Map
      defaultCenter={source}
      defaultZoom={15}
      mapId={MAP_ID}
      gestureHandling="greedy"
      className="h-full w-full"
      style={{ width: "100%", height: "100%" }}
      onClick={(e) => {
        if (e.detail?.latLng) {
          onMapClick(e.detail.latLng);
        }
      }}
    >
      <AutoFitBounds source={source} destination={destination} />
      <FollowDriver position={position} enabled={true} />

      {position && route.length > 1 ? (
        <Polyline
          path={route}
          strokeColor="#94a3b8"
          strokeWeight={4}
          strokeOpacity={0.4}
          clickable={false}
        />
      ) : null}

      {remainingRoute.length > 1 ? (
        <Polyline
          path={remainingRoute}
          strokeColor="#2563eb"
          strokeWeight={5}
          strokeOpacity={0.88}
          clickable={false}
        />
      ) : null}

      <AdvancedMarker
        position={source}
        title={source.name}
        zIndex={200}
        anchorLeft="-21px"
        anchorTop="-48px"
      >
        <PlacePin color="#282c3f" glyph={storeGlyph} label={source.name} />
      </AdvancedMarker>

      {destination ? (
        <AdvancedMarker
          position={destination}
          title={destination.name}
          zIndex={300}
          anchorLeft="-21px"
          anchorTop="-48px"
        >
          <PlacePin color="#282c3f" glyph={homeGlyph} label={destination.name} />
        </AdvancedMarker>
      ) : null}

      {position ? <MovingDriver position={position} heading={heading} /> : null}
    </Map>
  );
}

export default function App() {
  const [source, setSource] = useState<LocationItem>(DEFAULT_SOURCE);
  const [destination, setDestination] = useState<LocationItem | null>(DEFAULT_DESTINATION);
  const [route, setRoute] = useState<LatLng[]>([]);
  const [routeStats, setRouteStats] = useState<{ distanceKm: number; durationMins: number } | null>(null);

  const [sourceQuery, setSourceQuery] = useState(DEFAULT_SOURCE.name);
  const [destQuery, setDestQuery] = useState(DEFAULT_DESTINATION.name);

  const [sourceResults, setSourceResults] = useState<PlaceSearchResult[]>([]);
  const [destResults, setDestResults] = useState<PlaceSearchResult[]>([]);
  const [isSearchingSource, setIsSearchingSource] = useState(false);
  const [isSearchingDest, setIsSearchingDest] = useState(false);
  const [showSourceDropdown, setShowSourceDropdown] = useState(false);
  const [showDestDropdown, setShowDestDropdown] = useState(false);

  const [position, setPosition] = useState<LatLng | null>(DEFAULT_SOURCE);
  const [heading, setHeading] = useState(0);

  const [pickMode, setPickMode] = useState<"none" | "source" | "destination">("none");
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const [simRunning, setSimRunning] = useState(false);
  const [simFinished, setSimFinished] = useState(false);
  const [saveTrip, setSaveTrip] = useState(false);
  const [followSocket, setFollowSocket] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [coveredMeters, setCoveredMeters] = useState(0);

  const [connected, setConnected] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  const lastSeq = useRef(-1);
  const seqRef = useRef(1);
  const localSeqs = useRef(new Set<number>());
  const simStepRef = useRef({ segment: 0, into: 0 });
  const positionRef = useRef<LatLng | null>(DEFAULT_SOURCE);
  const routeRef = useRef(route);
  const simRunningRef = useRef(simRunning);
  const followSocketRef = useRef(followSocket);
  const totalRouteMeters = useMemo(() => calculateRouteDistance(route), [route]);

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => {
    simRunningRef.current = simRunning;
  }, [simRunning]);

  useEffect(() => {
    followSocketRef.current = followSocket;
  }, [followSocket]);

  const placeMarker = (next: LatLng) => {
    const prev = positionRef.current;
    if (prev && metersBetween(prev, next) > 4) setHeading(bearing(prev, next));
    positionRef.current = next;
    setPosition(next);
  };

  const postDriverFix = (point: LatLng) => {
    const seq = seqRef.current;
    seqRef.current += 1;
    localSeqs.current.add(seq);
    fetch(`${API_ORIGIN}/api/location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: ORDER_ID,
        driverId: DRIVER_ID,
        lat: point.lat,
        lng: point.lng,
        ts: Date.now(),
        seq,
      }),
    })
      .then((response) => {
        if (!response.ok) throw new Error("location post failed");
        setSyncError(null);
      })
      .catch(() => {
        setSyncError("The server did not save the latest driver position.");
      });
  };

  useEffect(() => {
    if (!saveTrip || !destination) return;
    const controller = new AbortController();
    fetch(`${API_ORIGIN}/api/location/destination`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: ORDER_ID,
        destination: { lat: destination.lat, lng: destination.lng },
        source: { lat: source.lat, lng: source.lng },
      }),
    })
      .then((response) => {
        if (!response.ok) throw new Error("destination post failed");
        setSyncError(null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSyncError("The server did not save this pickup and drop-off.");
      });
    return () => controller.abort();
  }, [saveTrip, source, destination]);

  useEffect(() => {
    if (!destination) {
      setRoute([]);
      setRouteStats(null);
      return;
    }

    const controller = new AbortController();
    const here = source;
    const there = destination;
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${here.lng},${here.lat};${there.lng},${there.lat}` +
      `?overview=full&geometries=geojson`;

    const straight = () => {
      setRoute([here, there]);
      const d = Number((metersBetween(here, there) / 1000).toFixed(1));
      setRouteStats({ distanceKm: d, durationMins: Math.max(1, Math.round(d * 2.5)) });
    };

    fetch(url, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error("OSRM failed");
        return res.json();
      })
      .then((data: {
        routes?: {
          distance?: number;
          duration?: number;
          geometry?: { coordinates?: [number, number][] };
        }[];
      }) => {
        const routeData = data.routes?.[0];
        const coordinates = routeData?.geometry?.coordinates;
        if (coordinates && coordinates.length > 0) {
          setRoute(coordinates.map(([lng, lat]) => ({ lat, lng })));
          const distanceKm = Number(((routeData.distance || 0) / 1000).toFixed(1));
          const durationMins = Math.max(1, Math.round((routeData.duration || 0) / 60));
          setRouteStats({ distanceKm, durationMins });
        } else {
          straight();
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        straight();
      });

    return () => controller.abort();
  }, [source, destination]);

  useEffect(() => {
    setSimRunning(false);
    setSimFinished(false);
    simStepRef.current = { segment: 0, into: 0 };
    if (followSocketRef.current) return;
    setCoveredMeters(0);
    positionRef.current = source;
    setPosition(source);
    setHeading(0);
  }, [source, destination]);

  useEffect(() => {
    if (!showSourceDropdown || sourceQuery.trim().length < 2) {
      setSourceResults([]);
      return;
    }
    const query = sourceQuery;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setIsSearchingSource(true);
      const results = await searchPlaces(query, source);
      if (cancelled) return;
      setSourceResults(results);
      setIsSearchingSource(false);
    }, 320);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setIsSearchingSource(false);
    };
  }, [sourceQuery, showSourceDropdown, source]);

  useEffect(() => {
    if (!showDestDropdown || destQuery.trim().length < 2) {
      setDestResults([]);
      return;
    }
    const query = destQuery;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setIsSearchingDest(true);
      const results = await searchPlaces(query, destination || source);
      if (cancelled) return;
      setDestResults(results);
      setIsSearchingDest(false);
    }, 320);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setIsSearchingDest(false);
    };
  }, [destQuery, showDestDropdown, destination, source]);

  const handleUseCurrentLocation = () => {
    if (!navigator.geolocation) {
      setGeoError("Geolocation is not supported by your browser");
      return;
    }
    setLocating(true);
    setGeoError(null);
    setPickMode("none");
    setShowDestDropdown(false);

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setLocating(false);
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const address = await reverseGeocode(lat, lng);
        const newDest: LocationItem = {
          lat,
          lng,
          name: "My Current Location",
          address,
        };
        setDestination(newDest);
        setDestQuery("My Current Location");
        setSaveTrip(true);
      },
      (err) => {
        setLocating(false);
        if (err.code === 1) {
          setGeoError("Location permission denied. Please allow access or search above.");
        } else if (err.code === 2) {
          setGeoError("Location unavailable. Try typing your address or landmark.");
        } else {
          setGeoError("Location request timed out. Please try searching above.");
        }
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  };

  const handleMapClick = async (coords: LatLng) => {
    if (pickMode === "source") {
      const address = await reverseGeocode(coords.lat, coords.lng);
      const newSource = {
        lat: coords.lat,
        lng: coords.lng,
        name: address.split(",")[0] || "Custom Pick-up",
        address,
      };
      setSource(newSource);
      setSourceQuery(newSource.name);
      setSaveTrip(true);
      setPickMode("none");
    } else if (pickMode === "destination") {
      const address = await reverseGeocode(coords.lat, coords.lng);
      const newDest = {
        lat: coords.lat,
        lng: coords.lng,
        name: address.split(",")[0] || "Custom Delivery Address",
        address,
      };
      setDestination(newDest);
      setDestQuery(newDest.name);
      setSaveTrip(true);
      setPickMode("none");
    }
  };

  useEffect(() => {
    const socket = io(API_ORIGIN);
    const onConnect = () => {
      setConnected(true);
      socket.emit("subscribe", ORDER_ID);
    };
    const onDisconnect = () => setConnected(false);
    const onLocation = (payload: { orderId: string; lat: number; lng: number; seq?: number }) => {
      if (payload.orderId !== ORDER_ID) return;
      if (typeof payload.seq === "number" && localSeqs.current.has(payload.seq)) return;
      if (typeof payload.seq === "number" && payload.seq < lastSeq.current) return;
      if (simRunningRef.current) return;
      if (typeof payload.seq === "number") lastSeq.current = payload.seq;

      const next = { lat: payload.lat, lng: payload.lng };
      const prev = positionRef.current;
      if (prev && metersBetween(prev, next) > 4) setHeading(bearing(prev, next));
      positionRef.current = next;
      setPosition(next);
      followSocketRef.current = true;
      setFollowSocket(true);
      const projected = projectOntoRoute(routeRef.current, next, 0);
      if (projected) setCoveredMeters(projected.covered);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("location", onLocation);
    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("location", onLocation);
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!followSocket || !positionRef.current || route.length < 2) return;
    const projected = projectOntoRoute(route, positionRef.current, 0);
    if (projected) setCoveredMeters(projected.covered);
  }, [route, followSocket]);

  useEffect(() => {
    if (!simRunning || route.length < 2) return;

    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      const { segment, into } = simStepRef.current;
      const nextStep = getNextRoutePosition(route, segment, into, STEP_METERS);
      simStepRef.current = { segment: nextStep.segment, into: nextStep.into };
      setCoveredMeters(calculateCoveredDistance(route, nextStep.segment, nextStep.into));

      const point = nextStep.arrived ? route[route.length - 1] : nextStep.pos;
      placeMarker(point);
      postDriverFix(point);

      if (nextStep.arrived) {
        stopped = true;
        setSimRunning(false);
        setSimFinished(true);
      }
    }, INTERVAL_MS);

    return () => clearInterval(timer);
  }, [simRunning, route]);

  const handleStartOrToggleSim = () => {
    if (simFinished) {
      setSimFinished(false);
      setFollowSocket(false);
      followSocketRef.current = false;
      simStepRef.current = { segment: 0, into: 0 };
      setCoveredMeters(0);
      positionRef.current = source;
      setPosition(source);
      setHeading(0);
      setSimRunning(true);
      return;
    }
    if (simRunning) {
      setSimRunning(false);
      return;
    }
    const current = positionRef.current ?? source;
    const projected =
      metersBetween(current, source) > 30 ? projectOntoRoute(route, current, 0) : null;
    if (projected) {
      simStepRef.current = { segment: projected.segment, into: projected.into };
      setCoveredMeters(projected.covered);
    } else {
      simStepRef.current = { segment: 0, into: 0 };
      setCoveredMeters(0);
    }
    setFollowSocket(false);
    followSocketRef.current = false;
    setSimRunning(true);
  };

  const handleResetSim = () => {
    setSimRunning(false);
    setSimFinished(false);
    simStepRef.current = { segment: 0, into: 0 };
    if (followSocketRef.current) return;
    setCoveredMeters(0);
    positionRef.current = source;
    setPosition(source);
    setHeading(0);
  };

  const progressPercent = totalRouteMeters > 0
    ? Math.min(100, Math.round((coveredMeters / totalRouteMeters) * 100))
    : 0;

  const currentStatusText = simFinished
    ? "Order Delivered 🎉"
    : simRunning || followSocket
      ? `Driver en route (${progressPercent}%)`
      : position && metersBetween(position, source) > 30
        ? "Simulation paused"
        : "Driver at restaurant";

  return (
    <div className="relative h-full w-full overflow-hidden font-sans">
      {MAPS_KEY ? (
        <APIProvider
          apiKey={MAPS_KEY}
          onError={() => setMapError("Google Maps rejected the API key.")}
        >
          {mapError ? (
            <div className="flex h-full items-center justify-center p-6 text-zinc-700">
              <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
                <p className="font-semibold text-red-800">Map Loading Error</p>
                <p className="mt-1 text-sm text-red-600">{mapError}</p>
              </div>
            </div>
          ) : (
            <DeliveryMap
              source={source}
              destination={destination}
              position={position}
              heading={heading}
              route={route}
              onMapClick={handleMapClick}
            />
          )}
        </APIProvider>
      ) : (
        <div className="flex h-full items-center justify-center p-6 text-zinc-700">
          <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
            Please add VITE_GOOGLE_MAPS_API_KEY to web/.env and restart Vite.
          </p>
        </div>
      )}

      {pickMode !== "none" && (
        <div className="absolute top-5 left-1/2 z-[1100] -translate-x-1/2 rounded-full border border-orange-200 bg-white/95 px-5 py-2.5 shadow-xl backdrop-blur-md">
          <div className="flex items-center gap-3">
            <span className="flex h-3 w-3 items-center justify-center">
              <span className="h-2.5 w-2.5 rounded-full bg-orange-500 animate-ping" />
            </span>
            <span className="text-xs font-semibold text-zinc-800">
              {pickMode === "source"
                ? "Click anywhere on the map to set Pick-up Restaurant"
                : "Click anywhere on the map to set Delivery Location"}
            </span>
            <button
              onClick={() => setPickMode("none")}
              className="ml-2 rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-semibold text-zinc-600 hover:bg-zinc-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div
        className={`absolute top-4 left-4 z-[1000] w-[400px] max-w-[calc(100vw-2rem)] rounded-2xl border border-zinc-200/80 bg-white/95 shadow-2xl backdrop-blur-md transition-all duration-300 ${
          panelCollapsed ? "p-3" : "p-4.5"
        }`}
      >
        <div className="flex items-center justify-between pb-2 border-b border-zinc-100">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-orange-500 text-white shadow-md shadow-orange-500/25">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a8 8 0 0 0-8 8c0 5.4 7 11.5 7.6 12a.6.6 0 0 0 .8 0c.6-.5 7.6-6.6 7.6-12a8 8 0 0 0-8-8z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold text-zinc-900 leading-tight">Live Delivery Tracking</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span
                  className={`h-2 w-2 rounded-full ${
                    connected ? "bg-emerald-500" : "bg-zinc-400"
                  }`}
                />
                <span className="text-[11px] font-medium text-zinc-500">
                  {currentStatusText}
                </span>
              </div>
            </div>
          </div>

          <button
            onClick={() => setPanelCollapsed(!panelCollapsed)}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition-colors"
            title={panelCollapsed ? "Expand panel" : "Collapse panel"}
          >
            <svg
              className={`h-4 w-4 transform transition-transform ${panelCollapsed ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {!panelCollapsed && (
          <div className="mt-3.5 space-y-3.5">
            <div className="relative">
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                  Pick-up Location (Restaurant)
                </label>
                <button
                  type="button"
                  onClick={() => setPickMode(pickMode === "source" ? "none" : "source")}
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border transition-all ${
                    pickMode === "source"
                      ? "border-orange-500 bg-orange-50 text-orange-600"
                      : "border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100"
                  }`}
                >
                  {pickMode === "source" ? "Clicking Map..." : "📍 Pick on Map"}
                </button>
              </div>

              <div className="relative flex items-center rounded-xl border border-zinc-200 bg-zinc-50/70 focus-within:border-orange-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-orange-100 transition-all">
                <span className="pl-3 text-zinc-400">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </span>
                <input
                  type="text"
                  value={sourceQuery}
                  onChange={(e) => {
                    setSourceQuery(e.target.value);
                    setShowSourceDropdown(true);
                  }}
                  onFocus={() => setShowSourceDropdown(true)}
                  placeholder="Search restaurant, cafe, or store..."
                  className="w-full bg-transparent px-2.5 py-2 text-xs font-medium text-zinc-800 placeholder-zinc-400 focus:outline-none"
                />
                {isSearchingSource && (
                  <span className="pr-2 text-zinc-400">
                    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                  </span>
                )}
                {sourceQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSourceQuery("");
                      setShowSourceDropdown(true);
                    }}
                    className="pr-2.5 text-zinc-400 hover:text-zinc-600 text-xs font-bold"
                  >
                    ✕
                  </button>
                )}
              </div>

              {showSourceDropdown && sourceResults.length > 0 && (
                <div className="search-dropdown absolute top-full left-0 right-0 z-[1200] mt-1 max-h-52 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-xl">
                  {sourceResults.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setSource({
                          lat: item.lat,
                          lng: item.lng,
                          name: item.name,
                          address: item.address,
                        });
                        setSourceQuery(item.name);
                        setSaveTrip(true);
                        setShowSourceDropdown(false);
                      }}
                      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-orange-50 transition-colors"
                    >
                      <span className="mt-0.5 text-orange-500">📍</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-zinc-900 truncate">{item.name}</p>
                        <p className="text-[10.5px] text-zinc-500 truncate">{item.address}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="relative">
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                  Delivery Location (Destination)
                </label>
                <button
                  type="button"
                  onClick={() => setPickMode(pickMode === "destination" ? "none" : "destination")}
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border transition-all ${
                    pickMode === "destination"
                      ? "border-orange-500 bg-orange-50 text-orange-600"
                      : "border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100"
                  }`}
                >
                  {pickMode === "destination" ? "Clicking Map..." : "📍 Pick on Map"}
                </button>
              </div>

              <div className="relative flex items-center rounded-xl border border-zinc-200 bg-zinc-50/70 focus-within:border-blue-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-100 transition-all">
                <span className="pl-3 text-zinc-400">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </span>
                <input
                  type="text"
                  value={destQuery}
                  onChange={(e) => {
                    setDestQuery(e.target.value);
                    setShowDestDropdown(true);
                  }}
                  onFocus={() => setShowDestDropdown(true)}
                  placeholder="Search home, apartment, colony, or landmark..."
                  className="w-full bg-transparent px-2.5 py-2 text-xs font-medium text-zinc-800 placeholder-zinc-400 focus:outline-none"
                />
                {isSearchingDest && (
                  <span className="pr-2 text-zinc-400">
                    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                  </span>
                )}
                {destQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setDestQuery("");
                      setShowDestDropdown(true);
                    }}
                    className="pr-2.5 text-zinc-400 hover:text-zinc-600 text-xs font-bold"
                  >
                    ✕
                  </button>
                )}
              </div>

              {showDestDropdown && destResults.length > 0 && (
                <div className="search-dropdown absolute top-full left-0 right-0 z-[1200] mt-1 max-h-52 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-xl">
                  {destResults.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setDestination({
                          lat: item.lat,
                          lng: item.lng,
                          name: item.name,
                          address: item.address,
                        });
                        setDestQuery(item.name);
                        setSaveTrip(true);
                        setShowDestDropdown(false);
                      }}
                      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-blue-50 transition-colors"
                    >
                      <span className="mt-0.5 text-blue-500">🏠</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-zinc-900 truncate">{item.name}</p>
                        <p className="text-[10.5px] text-zinc-500 truncate">{item.address}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={handleUseCurrentLocation}
                disabled={locating}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-3 py-2 text-xs font-semibold text-white shadow-md shadow-blue-500/20 hover:from-blue-700 hover:to-indigo-700 active:scale-[0.99] transition-all disabled:opacity-70"
              >
                {locating ? (
                  <svg className="h-4 w-4 animate-spin text-white" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                  </svg>
                )}
                <span>{locating ? "Detecting GPS location..." : "🎯 Use My Current Location"}</span>
              </button>

              {geoError && (
                <div className="mt-1.5 rounded-lg bg-red-50 p-2 text-[11px] text-red-700 border border-red-200">
                  <p>{geoError}</p>
                </div>
              )}
            </div>

            {syncError ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
                {syncError}
              </p>
            ) : null}

            {routeStats && (
              <div className="flex items-center justify-between rounded-xl bg-blue-50/70 px-3 py-2 border border-blue-100 text-blue-900">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="3 11 22 2 13 21 11 13 3 11" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-zinc-900">{routeStats.distanceKm} km • ~{routeStats.durationMins} mins</p>
                    <p className="text-[10px] font-medium text-blue-700">
                      {syncError ? "Shown on the map. Not saved to the server." : saveTrip ? "Road route saved" : "Preview route"}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-800">
                    Fastest
                  </span>
                </div>
              </div>
            )}

            <div className="pt-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleStartOrToggleSim}
                  className={`flex-1 rounded-xl px-4 py-2.5 text-xs font-bold text-white shadow-lg transition-all active:scale-[0.98] ${
                    simFinished
                      ? "bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/30"
                      : simRunning
                        ? "bg-amber-500 hover:bg-amber-600 shadow-amber-500/30"
                        : "bg-orange-500 hover:bg-orange-600 shadow-orange-500/30"
                  }`}
                >
                  {simFinished
                    ? "🎉 Replay Delivery"
                    : simRunning
                      ? "⏸ Pause Delivery"
                      : "🚀 Start Delivery Simulation"}
                </button>

                <button
                  type="button"
                  onClick={handleResetSim}
                  className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 active:scale-95 transition-all"
                  title="Reset Driver"
                >
                  🔄
                </button>
              </div>

              <div className="mt-2.5 flex items-center justify-between text-xs text-zinc-600">
                <span className="text-[11px] font-medium text-zinc-500">
                  Speed: <span className="font-semibold text-zinc-800">City Pace (36 km/h)</span>
                </span>
                {routeStats && (
                  <span className="text-[11px] font-medium text-zinc-400">
                    {routeStats.distanceKm} km trip
                  </span>
                )}
              </div>

              {route.length > 0 && (
                <div className="mt-2">
                  <div className="h-1.5 w-full rounded-full bg-zinc-100 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-orange-500 to-amber-500 transition-all duration-300"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-lg bg-zinc-50 p-2 text-[10px] text-zinc-500 border border-zinc-100">
              💡 <span className="font-semibold text-zinc-700">Terminal simulation:</span> Run <code className="bg-zinc-200/80 px-1 py-0.5 rounded font-mono text-[9.5px] text-zinc-800">node simulate-driver.js</code> to stream telemetry via Redis & Socket.IO!
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
