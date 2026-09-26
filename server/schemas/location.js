import { z } from "zod";

export const locationSchema = z.object({
  orderId: z.string().min(1),
  driverId: z.string().min(1),
  lat: z.number().finite().gte(-90).lte(90),
  lng: z.number().finite().gte(-180).lte(180),
  ts: z.number().finite(),
  seq: z.number().finite(),
});