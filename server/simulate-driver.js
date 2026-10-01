const ORDER_ID = "ord_123";
const DRIVER_ID = "drv_9";
const INTERVAL_MS = 2000;
const STEP_METERS = 20;
// Ignore GPS noise. A real home change starts a new trip from Pizza Hut.
const REROUTE_METERS = 150;

// Pizza Hut, GE Road, Raipur. The trip always begins here.
const STORE = { lat: 21.2439414, lng: 81.6076675 };

let currentSource = STORE;
let currentDestination = null;
let route = [[STORE.lat, STORE.lng]];
let seq = Date.now();
let segment = 0;
let into = 0;
let currentPos = [STORE.lat, STORE.lng];
let arrived = false;
let waitingLogged = false;
let ticking = false;

function metersBetween(a, b) {
  const earth = 6371000;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function fetchRoute(from, to) {
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM status ${res.status}`);
    const data = await res.json();
    const coordinates = data.routes?.[0]?.geometry?.coordinates;
    if (coordinates && coordinates.length > 1) {
      return coordinates.map(([lng, lat]) => [lat, lng]);
    }
  } catch (err) {
    console.warn(`Could not fetch OSRM route: ${err.message}. Using direct path.`);
  }
  return [[from.lat, from.lng], [to.lat, to.lng]];
}

async function readTripConfig() {
  const res = await fetch(`http://localhost:3000/api/location/destination/${ORDER_ID}`);
  if (!res.ok) return null;
  const data = await res.json();
  const destLat = data.destination?.lat;
  const destLng = data.destination?.lng;
  if (!data.ok || !Number.isFinite(destLat) || !Number.isFinite(destLng)) return null;

  const destination = { lat: destLat, lng: destLng };
  const source =
    data.source && Number.isFinite(data.source.lat) && Number.isFinite(data.source.lng)
      ? { lat: data.source.lat, lng: data.source.lng }
      : STORE;

  return { destination, source };
}

async function beginTrip(source, destination) {
  currentSource = source;
  currentDestination = destination;
  route = await fetchRoute(source, destination);
  segment = 0;
  into = 0;
  arrived = false;
  const end = route[route.length - 1];
  console.log(
    `Trip: Source (${source.lat.toFixed(5)}, ${source.lng.toFixed(5)}) -> Destination (${destination.lat.toFixed(5)}, ${destination.lng.toFixed(5)})`,
  );
  console.log(
    `Road route has ${route.length} points, ending ${end[0].toFixed(5)}, ${end[1].toFixed(5)}`,
  );
  await send(source.lat, source.lng);
}

async function checkTrip() {
  let trip;
  try {
    trip = await readTripConfig();
  } catch {
    return;
  }
  if (!trip) return;

  if (!currentDestination) {
    waitingLogged = false;
    await beginTrip(trip.source, trip.destination);
    return;
  }

  const destMoved = metersBetween(
    [currentDestination.lat, currentDestination.lng],
    [trip.destination.lat, trip.destination.lng],
  );
  const srcMoved = metersBetween(
    [currentSource.lat, currentSource.lng],
    [trip.source.lat, trip.source.lng],
  );

  if (destMoved < REROUTE_METERS && srcMoved < REROUTE_METERS) return;

  console.log("Trip locations changed. Starting fresh route...");
  await beginTrip(trip.source, trip.destination);
}

async function send(lat, lng) {
  currentPos = [lat, lng];
  const response = await fetch("http://localhost:3000/api/location", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderId: ORDER_ID,
      driverId: DRIVER_ID,
      lat,
      lng,
      ts: Date.now(),
      seq,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }

  console.log(`seq ${seq}  ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
  seq += 1;
}

function nextPoint() {
  if (segment >= route.length - 1) {
    return route[route.length - 1];
  }

  let left = STEP_METERS;

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
      return [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
      ];
    }

    left -= remain;
    segment += 1;
    into = 0;
  }

  return route[route.length - 1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function start() {
  console.log("Driver waiting for restaurant and customer locations from map...");

  while (!currentDestination) {
    await checkTrip();
    if (!currentDestination) {
      if (!waitingLogged) {
        console.log("Waiting for trip configuration. Open http://localhost:5173 to select locations.");
        waitingLogged = true;
      }
      await sleep(INTERVAL_MS);
    }
  }

  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await checkTrip();
      if (!currentDestination || route.length < 2) return;

      if (segment >= route.length - 1) {
        if (!arrived) {
          arrived = true;
          const end = route[route.length - 1];
          await send(end[0], end[1]);
          console.log("Driver reached destination.");
        }
        return;
      }

      const [lat, lng] = nextPoint();
      await send(lat, lng);
    } catch (error) {
      console.error(error.message);
    } finally {
      ticking = false;
    }
  }, INTERVAL_MS);
}

start();
