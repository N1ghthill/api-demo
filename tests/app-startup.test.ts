import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../lib/app.js";

test("createApp can initialize without DATABASE_URL for non-DB routes", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  try {
    delete process.env.DATABASE_URL;
    const app = createApp();
    assert.ok(app);
  } finally {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
});
