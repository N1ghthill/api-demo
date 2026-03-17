import express from "express";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import health from "../api/health.js";
import courses from "../api/courses.js";
import leads from "../api/leads.js";
import payments from "../api/payments.js";
import { withApiHandler } from "./apiHandler.js";

function adapt(
  handler: (req: VercelRequest, res: VercelResponse) => unknown | Promise<unknown>
): (req: express.Request, res: express.Response) => unknown | Promise<unknown> {
  return (req: express.Request, res: express.Response) =>
    handler(req as unknown as VercelRequest, res as unknown as VercelResponse);
}

const notFound = withApiHandler(({ fail }) => {
  fail(404, "not_found", "Route not found.");
}, { cacheControl: "no-store" });

export function createApp(): express.Express {
  const app = express();

  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.all("/api/health", adapt(health));
  app.all("/api/courses", adapt(courses));
  app.all("/api/leads", adapt(leads));
  app.all("/api/payments", adapt(payments));

  app.use(adapt(notFound));

  return app;
}
