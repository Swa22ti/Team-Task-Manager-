import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not set. Add a PostgreSQL database URL before starting the app.");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(160) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role VARCHAR(16) NOT NULL CHECK (role IN ('admin', 'member')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title VARCHAR(160) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
      priority VARCHAR(12) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
      due_date DATE,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id ON tasks(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members(user_id);
  `);
}
