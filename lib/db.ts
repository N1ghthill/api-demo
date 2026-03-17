import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { env } from "./env.js";

let pool: Pool | null = null;

function createPool(): Pool {
  const connectionString = env("DATABASE_URL");
  const useSupabaseSsl = /supabase\.co|supabase\.com/i.test(connectionString);

  return new Pool({
    connectionString,
    ...(useSupabaseSsl ? { ssl: { rejectUnauthorized: false } } : {})
  });
}

function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }

  return pool;
}

export type DbClient = PoolClient;

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function withClient<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
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

export async function closePool(): Promise<void> {
  if (!pool) return;

  const currentPool = pool;
  pool = null;
  await currentPool.end();
}
