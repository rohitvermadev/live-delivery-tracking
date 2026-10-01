import { Server } from "socket.io";

let io;

export function attachSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  io.on("connection", (socket) => {
    socket.on("subscribe", (orderId) => {
      if (typeof orderId === "string" && orderId.length > 0) {
        socket.join(orderId);
      }
    });
  });
}

export function publishLocation(payload) {
  io?.to(payload.orderId).emit("location", payload);
}