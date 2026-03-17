import "./lib/loadEnv.js";
import { createApp } from "./lib/app.js";
import { logger } from "./lib/logger.js";

const app = createApp();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  logger.info({ port }, "api_demo_server_started");
});
