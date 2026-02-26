import { withApiHandler, type ApiHandlerContext } from "../lib/apiHandler.js";

async function healthHandler({ res }: ApiHandlerContext): Promise<void> {
  res.status(200).json({ ok: true });
}

export default withApiHandler(healthHandler, { cacheControl: "no-store" });
