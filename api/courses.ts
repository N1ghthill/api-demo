import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors } from "../lib/cors.js";
import { query } from "../lib/db.js";
import { applySecurityHeaders } from "../lib/http.js";
import { rateLimit } from "../lib/rateLimit.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applySecurityHeaders(req, res);
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).end();

  if (rateLimit(req, res, { keyPrefix: "courses", windowMs: 60_000, max: 120 })) return;

  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");

  try {
    const { rows } = await query(
      `select id, slug, name, price_cents, active, track, area, workload_hours, modality,
              duration_months_min, duration_months_max, tcc_required
         from courses
        where active = true
        order by name asc`
    );
    res.status(200).json({ courses: rows ?? [] });
  } catch (error) {
    console.error("Failed to fetch courses", error);
    return res.status(500).json({ error: "courses_fetch_failed" });
  }
}
