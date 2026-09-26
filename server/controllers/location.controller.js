import prisma from "../config/db.js";
import { locationSchema } from "../schemas/location.js";

export async function updateLocation(req, res) {
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Invalid location payload",
    });
  }

  const { orderId, driverId, lat, lng, ts, seq } = parsed.data;
  const data = {
    driverId,
    lat,
    lng,
    ts: BigInt(ts),
    seq: BigInt(seq),
  };

  try {
    await prisma.orderLocation.upsert({
      where: { orderId },
      create: { orderId, ...data },
      update: data,
    });
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      error: error.message,
    });
  }
}