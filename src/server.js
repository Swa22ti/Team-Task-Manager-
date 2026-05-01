import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { migrate, pool, query, transaction } from "./db.js";

const app = express();
const port = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET || "dev-secret-change-me";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "../public")));

const signupSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(160).transform((value) => value.toLowerCase()).refine((email) => {
    const domain = email.split("@")[1] || "";
    const blockedDomains = new Set(["example.com", "example.org", "example.net", "test.com", "localhost"]);
    return domain.includes(".") && !blockedDomains.has(domain);
  }, "Use a real email address."),
  password: z.string().min(6).max(80),
  role: z.enum(["admin", "member"]).default("member")
});

const loginSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1)
});

const projectSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional().default(""),
  memberIds: z.array(z.number().int().positive()).optional().default([])
});

const taskSchema = z.object({
  projectId: z.number().int().positive(),
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1500).optional().default(""),
  assigneeId: z.number().int().positive().nullable().optional(),
  status: z.enum(["todo", "in_progress", "done"]).optional().default("todo"),
  priority: z.enum(["low", "medium", "high"]).optional().default("medium"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
});

const statusSchema = z.object({
  status: z.enum(["todo", "in_progress", "done"])
});

function sendError(res, status, message, details) {
  res.status(status).json({ error: message, details });
}

function tokenFor(user) {
  return jwt.sign({ id: user.id, role: user.role }, jwtSecret, { expiresIn: "7d" });
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

async function auth(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return sendError(res, 401, "Authentication required.");

  try {
    const payload = jwt.verify(token, jwtSecret);
    const { rows } = await query("SELECT id, name, email, role FROM users WHERE id = $1", [payload.id]);
    if (!rows[0]) return sendError(res, 401, "Invalid session.");
    req.user = rows[0];
    next();
  } catch {
    sendError(res, 401, "Invalid or expired session.");
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return sendError(res, 403, "Admin access required.");
  next();
}

async function canAccessProject(user, projectId) {
  if (user.role === "admin") return true;
  const { rowCount } = await query(
    "SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2",
    [projectId, user.id]
  );
  return rowCount > 0;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid signup data.", parsed.error.flatten());

  const { name, email, password, role } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const { rows } = await query(
      "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role",
      [name, email, passwordHash, role]
    );
    res.status(201).json({ user: publicUser(rows[0]), token: tokenFor(rows[0]) });
  } catch (error) {
    if (error.code === "23505") return sendError(res, 409, "Email is already registered.");
    throw error;
  }
});

app.post("/api/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid login data.", parsed.error.flatten());

  const { rows } = await query("SELECT * FROM users WHERE email = $1", [parsed.data.email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
    return sendError(res, 401, "Invalid email or password.");
  }

  res.json({ user: publicUser(user), token: tokenFor(user) });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get("/api/users", auth, async (_req, res) => {
  const { rows } = await query("SELECT id, name, email, role FROM users ORDER BY name ASC");
  res.json({ users: rows });
});

app.get("/api/projects", auth, async (req, res) => {
  const sql = req.user.role === "admin"
    ? `SELECT p.*, u.name AS owner_name, COUNT(pm.user_id)::int AS member_count
       FROM projects p
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN project_members pm ON pm.project_id = p.id
       GROUP BY p.id, u.name
       ORDER BY p.created_at DESC`
    : `SELECT p.*, u.name AS owner_name, COUNT(pm_all.user_id)::int AS member_count
       FROM projects p
       JOIN users u ON u.id = p.owner_id
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
       LEFT JOIN project_members pm_all ON pm_all.project_id = p.id
       GROUP BY p.id, u.name
       ORDER BY p.created_at DESC`;
  const params = req.user.role === "admin" ? [] : [req.user.id];
  const { rows } = await query(sql, params);
  res.json({ projects: rows });
});

app.post("/api/projects", auth, requireAdmin, async (req, res) => {
  const parsed = projectSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid project data.", parsed.error.flatten());

  const project = await transaction(async (client) => {
    const { rows } = await client.query(
      "INSERT INTO projects (name, description, owner_id) VALUES ($1, $2, $3) RETURNING *",
      [parsed.data.name, parsed.data.description, req.user.id]
    );
    const memberIds = [...new Set([req.user.id, ...parsed.data.memberIds])];
    for (const userId of memberIds) {
      await client.query(
        "INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [rows[0].id, userId]
      );
    }
    return rows[0];
  });

  res.status(201).json({ project });
});

app.get("/api/projects/:id", auth, async (req, res) => {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(req.user, projectId))) return sendError(res, 403, "Project access denied.");

  const [{ rows: projectRows }, { rows: memberRows }, { rows: taskRows }] = await Promise.all([
    query("SELECT * FROM projects WHERE id = $1", [projectId]),
    query(
      `SELECT u.id, u.name, u.email, u.role
       FROM project_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 ORDER BY u.name ASC`,
      [projectId]
    ),
    query(
      `SELECT t.*, u.name AS assignee_name, c.name AS creator_name
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users c ON c.id = t.created_by
       WHERE t.project_id = $1
       ORDER BY t.created_at DESC`,
      [projectId]
    )
  ]);

  if (!projectRows[0]) return sendError(res, 404, "Project not found.");
  res.json({ project: projectRows[0], members: memberRows, tasks: taskRows });
});

app.patch("/api/projects/:id/members", auth, requireAdmin, async (req, res) => {
  const body = z.object({ memberIds: z.array(z.number().int().positive()) }).safeParse(req.body);
  if (!body.success) return sendError(res, 400, "Invalid member list.", body.error.flatten());

  const projectId = Number(req.params.id);
  const { rows } = await query("SELECT owner_id FROM projects WHERE id = $1", [projectId]);
  if (!rows[0]) return sendError(res, 404, "Project not found.");

  const memberIds = [...new Set([rows[0].owner_id, ...body.data.memberIds])];
  await transaction(async (client) => {
    await client.query("DELETE FROM project_members WHERE project_id = $1", [projectId]);
    for (const userId of memberIds) {
      await client.query("INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)", [projectId, userId]);
    }
  });

  res.json({ ok: true });
});

app.post("/api/tasks", auth, async (req, res) => {
  const parsed = taskSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid task data.", parsed.error.flatten());
  const task = parsed.data;

  if (req.user.role !== "admin" && task.assigneeId !== req.user.id) {
    return sendError(res, 403, "Members can only create tasks assigned to themselves.");
  }
  if (!(await canAccessProject(req.user, task.projectId))) return sendError(res, 403, "Project access denied.");

  if (task.assigneeId) {
    const { rowCount } = await query(
      "SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2",
      [task.projectId, task.assigneeId]
    );
    if (rowCount === 0) return sendError(res, 400, "Assignee must be a project member.");
  }

  const { rows } = await query(
    `INSERT INTO tasks (project_id, title, description, assignee_id, status, priority, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [task.projectId, task.title, task.description, task.assigneeId || null, task.status, task.priority, task.dueDate || null, req.user.id]
  );
  res.status(201).json({ task: rows[0] });
});

app.patch("/api/tasks/:id/status", auth, async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "Invalid status.", parsed.error.flatten());

  const { rows } = await query("SELECT * FROM tasks WHERE id = $1", [Number(req.params.id)]);
  const task = rows[0];
  if (!task) return sendError(res, 404, "Task not found.");
  if (!(await canAccessProject(req.user, task.project_id))) return sendError(res, 403, "Project access denied.");
  if (req.user.role !== "admin" && task.assignee_id !== req.user.id) {
    return sendError(res, 403, "Members can only update tasks assigned to them.");
  }

  const updated = await query(
    "UPDATE tasks SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    [parsed.data.status, task.id]
  );
  res.json({ task: updated.rows[0] });
});

app.get("/api/dashboard", auth, async (req, res) => {
  const params = req.user.role === "admin" ? [] : [req.user.id];
  const visibilityJoin = req.user.role === "admin"
    ? ""
    : "JOIN project_members pm ON pm.project_id = t.project_id AND pm.user_id = $1";

  const { rows: summary } = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE t.status = 'todo')::int AS todo,
       COUNT(*) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
       COUNT(*) FILTER (WHERE t.status = 'done')::int AS done,
       COUNT(*) FILTER (WHERE t.status <> 'done' AND t.due_date < CURRENT_DATE)::int AS overdue
     FROM tasks t ${visibilityJoin}`,
    params
  );

  const { rows: tasks } = await query(
    `SELECT t.*, p.name AS project_name, u.name AS assignee_name
     FROM tasks t
     JOIN projects p ON p.id = t.project_id
     LEFT JOIN users u ON u.id = t.assignee_id
     ${visibilityJoin}
     WHERE t.status <> 'done'
     ORDER BY t.due_date ASC NULLS LAST, t.priority DESC, t.created_at DESC
     LIMIT 8`,
    params
  );

  res.json({ summary: summary[0], upcomingTasks: tasks });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  sendError(res, 500, "Something went wrong.");
});

migrate()
  .then(() => {
    app.listen(port, () => {
      console.log(`Team Task Manager running on port ${port}`);
    });
  })
  .catch(async (error) => {
    console.error("Failed to start app:", error);
    await pool.end();
    process.exit(1);
  });
