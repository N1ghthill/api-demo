import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { env } from "./env.js";

const connectionString = env("DATABASE_URL");
const useSupabaseSsl = /supabase\.co|supabase\.com/i.test(connectionString);

const pool = new Pool({
  connectionString,
  ...(useSupabaseSsl ? { ssl: { rejectUnauthorized: false } } : {})
});

export type DbClient = PoolClient;

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function withClient<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
      throw error;
    }
  });
}
