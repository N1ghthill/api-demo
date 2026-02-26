import type { VercelRequest, VercelResponse } from "@vercel/node";
import { cors } from "../lib/cors.js";
import { applySecurityHeaders } from "../lib/http.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  applySecurityHeaders(req, res);
  if (cors(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true });
}
