import "./lib/loadEnv.js";
import express from "express";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import health from "./api/health.js";
import courses from "./api/courses.js";
import leads from "./api/leads.js";
import payments from "./api/payments.js";
import { logger } from "./lib/logger.js";

const app = express();

app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

const adapt =
  (handler: (req: VercelRequest, res: VercelResponse) => unknown | Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    handler(req as unknown as VercelRequest, res as unknown as VercelResponse);

app.all("/api/health", adapt(health));
app.all("/api/courses", adapt(courses));
app.all("/api/leads", adapt(leads));
app.all("/api/payments", adapt(payments));

app.use((_req: express.Request, res: express.Response) => {
  res.status(404).json({ error: "not_found" });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  logger.info({ port }, "api_demo_server_started");
});
