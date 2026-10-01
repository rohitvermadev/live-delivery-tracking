import redis from "../redis.js";
import { locationSchema } from "../schemas/location.js";
import { publishLocation } from "../socket.js";

const useRedis = process.env.STORE === "redis";
const LOCATION_TTL_SECONDS = 45;

console.log(`Location store: ${useRedis ? "redis" : "postgres"}`);

let prismaPromise;

function getPrisma() {
  if (!prismaPromise) {
    prismaPromise = import("../config/db.js").then((module) => module.default);
  }
  return prismaPromise;
}

export async function updateLocation(req, res) {
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Invalid location payload",
    });
  }

  try {
    if (useRedis) {
      await writeRedis(parsed.data);
    } else {
      await writePostgres(parsed.data);
    }
    publishLocation(parsed.data);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      error: error.message,
    });
  }
}

async function writeRedis(payload) {
  const key = `location:order:${payload.orderId}`;
  await redis.set(key, JSON.stringify(payload), "EX", LOCATION_TTL_SECONDS);
}

async function writePostgres(payload) {
  const prisma = await getPrisma();
  const data = {
    driverId: payload.driverId,
    lat: payload.lat,
    lng: payload.lng,
    ts: BigInt(payload.ts),
    seq: BigInt(payload.seq),
  };

  await prisma.orderLocation.upsert({
    where: { orderId: payload.orderId },
    create: { orderId: payload.orderId, ...data },
    update: data,
  });
}

export async function setOrderDestination(req, res) {
  const { orderId, destination, source } = req.body;
  if (!orderId || !destination || typeof destination.lat !== "number" || typeof destination.lng !== "number") {
    return res.status(400).json({ ok: false, error: "Invalid destination payload" });
  }

  try {
    const key = `destination:order:${orderId}`;
    const payload = {
      destination,
      source: source && typeof source.lat === "number" && typeof source.lng === "number" ? source : null,
    };
    await redis.set(key, JSON.stringify(payload));
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

export async function getOrderDestination(req, res) {
  const { orderId } = req.params;
  try {
    const key = `destination:order:${orderId}`;
    const raw = await redis.get(key);
    if (!raw) {
      return res.status(404).json({ ok: false, error: "Destination not found" });
    }
    const data = JSON.parse(raw);
    if (data && data.destination) {
      return res.status(200).json({ ok: true, destination: data.destination, source: data.source || null });
    }
    return res.status(200).json({ ok: true, destination: data, source: null });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
