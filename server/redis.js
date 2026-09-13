import Redis from "ioredis";

const redis = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: 10,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on("connect", () => {
  console.log("Connected to Redis server");
});

redis.on("ready", () => {
  console.log("Redis client ready to receive commands");
});

redis.on("error", (err) => {
  console.error("Redis connection error:", err.message);
});

export default redis;
