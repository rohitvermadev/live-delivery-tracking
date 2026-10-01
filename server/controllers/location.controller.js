import redis from "../redis.js";
import { locationSchema } from "../schemas/location.js";

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
