import { config } from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();
const localPath = resolve(cwd, ".env.local");
const defaultPath = resolve(cwd, ".env");

if (existsSync(localPath)) {
  config({ path: localPath });
} else if (existsSync(defaultPath)) {
  config({ path: defaultPath });
}
