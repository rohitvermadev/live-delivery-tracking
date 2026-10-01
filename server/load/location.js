import http from "k6/http";
import { check } from "k6";

export const options = {
  vus: 100,
  duration: "20s",
};

export default function () {
  const id = Math.floor(Math.random() * 1000);
  const body = JSON.stringify({
    orderId: `ord_${id}`,
    driverId: `drv_${id % 200}`,
    lat: 12.97,
    lng: 77.59,
    ts: Date.now(),
    seq: Date.now(),
  });

  const res = http.post("http://localhost:3000/api/location", body, {
    headers: { "Content-Type": "application/json" },
  });

  check(res, { "status 200": (r) => r.status === 200 });
}
