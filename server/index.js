import express from "express";
import redis from "./redis.js";
import http from "http"

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.json())

app.get("/", (req, res) => {
    res.json({message: "Live Delivery Tracking Server is running"});
});

// Health check endpoint for Redis & server
app.get("/health", async (req, res) => {
  try {
    const pingResponse = await redis.ping();
    if (pingResponse === "PONG") {
      return res.status(200).json({
        ok: true,
        status: "healthy",
        redis: {
          connected: true,
          status: redis.status,
        },
      });
    }
    return res.status(503).json({
      ok: false,
      status: "unhealthy",
      redis: {
        connected: false,
        message: "Redis ping failed",
      },
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      status: "unhealthy",
      redis: {
        connected: false,
        error: error.message,
      },
    });
  }
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
