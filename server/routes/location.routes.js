import { Router } from "express";
import { updateLocation } from "../controllers/location.controller.js";

const router = Router();

router.post("/", updateLocation);

export default router;
