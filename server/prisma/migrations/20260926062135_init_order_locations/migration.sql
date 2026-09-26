-- CreateTable
CREATE TABLE "order_locations" (
    "order_id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "ts" BIGINT NOT NULL,
    "seq" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_locations_pkey" PRIMARY KEY ("order_id")
);
