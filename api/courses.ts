import { withApiHandler, type ApiHandlerContext } from "../lib/apiHandler.js";
import { query } from "../lib/db.js";
import { sanitizeError } from "../lib/logger.js";

async function coursesHandler({ res, fail, log }: ApiHandlerContext): Promise<void> {
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
    log.error({ error: sanitizeError(error) }, "courses_fetch_failed");
    fail(500, "courses_fetch_failed", "Failed to fetch courses.");
  }
}

export default withApiHandler(coursesHandler, {
  methods: ["GET"],
  rateLimit: { keyPrefix: "courses", windowMs: 60_000, max: 120 },
  cacheControl: "public, max-age=60, s-maxage=300, stale-while-revalidate=600"
});
