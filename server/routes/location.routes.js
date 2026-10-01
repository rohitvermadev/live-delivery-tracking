import { Router } from "express";
import {
  updateLocation,
  setOrderDestination,
  getOrderDestination,
} from "../controllers/location.controller.js";

const router = Router();

router.post("/", updateLocation);
router.post("/destination", setOrderDestination);
router.get("/destination/:orderId", getOrderDestination);

export default router;
