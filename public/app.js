const app = document.querySelector("#app");
const state = {
  token: localStorage.getItem("ttm_token"),
  user: JSON.parse(localStorage.getItem("ttm_user") || "null"),
  users: [],
  projects: [],
  currentProject: null,
  projectDetails: null,
  dashboard: null,
  authMode: "login",
  error: ""
};

const statusLabels = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done"
};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function saveSession(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem("ttm_token", data.token);
  localStorage.setItem("ttm_user", JSON.stringify(data.user));
}

function logout() {
  localStorage.removeItem("ttm_token");
  localStorage.removeItem("ttm_user");
  Object.assign(state, { token: null, user: null, projects: [], currentProject: null, projectDetails: null, error: "" });
  render();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function isOverdue(task) {
  if (!task.due_date || task.status === "done") return false;
  return new Date(task.due_date) < new Date(new Date().toDateString());
}

async function loadApp() {
  if (!state.token) return;
  try {
    const [users, projects, dashboard] = await Promise.all([
      api("/api/users"),
      api("/api/projects"),
      api("/api/dashboard")
    ]);
    state.users = users.users;
    state.projects = projects.projects;
    state.dashboard = dashboard;
    if (!state.currentProject && state.projects[0]) state.currentProject = state.projects[0].id;
    if (state.currentProject) await loadProject(state.currentProject, false);
  } catch (error) {
    state.error = error.message;
    if (error.message.includes("session")) logout();
  }
}

async function loadProject(projectId, shouldRender = true) {
  state.currentProject = Number(projectId);
  state.projectDetails = await api(`/api/projects/${projectId}`);
  if (shouldRender) render();
}

async function handleAuth(event) {
  event.preventDefault();
  state.error = "";
  const values = formData(event.currentTarget);
  try {
    const payload = state.authMode === "signup"
      ? { name: values.name, email: values.email, password: values.password, role: values.role }
      : { email: values.email, password: values.password };
    const data = await api(`/api/auth/${state.authMode}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    saveSession(data);
    await loadApp();
  } catch (error) {
    state.error = error.message;
  }
  render();
}

async function createProject(event) {
  event.preventDefault();
  const values = formData(event.currentTarget);
  const memberIds = [...event.currentTarget.querySelector("[name=memberIds]").selectedOptions].map((option) => Number(option.value));
  await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: values.name, description: values.description, memberIds })
  });
  event.currentTarget.reset();
  await loadApp();
  render();
}

async function createTask(event) {
  event.preventDefault();
  const values = formData(event.currentTarget);
  await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      projectId: Number(values.projectId),
      title: values.title,
      description: values.description,
      assigneeId: values.assigneeId ? Number(values.assigneeId) : null,
      priority: values.priority,
      dueDate: values.dueDate || null
    })
  });
  event.currentTarget.reset();
  await loadApp();
  render();
}

async function updateStatus(taskId, status) {
  await api(`/api/tasks/${taskId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
  await loadApp();
  render();
}

function authView() {
  app.innerHTML = `
    <section class="auth-page">
      <div class="auth-panel">
        <h1 class="brand">Team Task Manager</h1>
        <p class="muted">Plan projects, assign work, and keep progress visible across the team.</p>
        <div class="tabs" role="tablist">
          <button class="${state.authMode === "login" ? "active" : ""}" data-mode="login">Login</button>
          <button class="${state.authMode === "signup" ? "active" : ""}" data-mode="signup">Signup</button>
        </div>
        <form id="auth-form">
          ${state.authMode === "signup" ? `
            <div class="field"><label>Name</label><input name="name" required minlength="2" /></div>
            <div class="field"><label>Role</label><select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></div>
          ` : ""}
          <div class="field"><label>Email</label><input name="email" type="email" required /></div>
          <div class="field"><label>Password</label><input name="password" type="password" required minlength="6" /></div>
          <button class="primary" type="submit">${state.authMode === "login" ? "Login" : "Create account"}</button>
          ${state.error ? `<p class="error">${state.error}</p>` : ""}
        </form>
      </div>
      <div class="auth-visual">
        <h1>Work moves faster when ownership is clear.</h1>
        <p>Admins organize projects and teams. Members see their assigned work, update status, and keep overdue tasks visible.</p>
      </div>
    </section>
  `;

  app.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.authMode = button.dataset.mode;
      state.error = "";
      render();
    });
  });
  app.querySelector("#auth-form").addEventListener("submit", handleAuth);
}

function projectForm() {
  if (state.user.role !== "admin") {
    return `<div class="notice">Members can view assigned projects, create their own project tasks, and update their assigned task status.</div>`;
  }
  return `
    <form class="form" id="project-form">
      <h2>New Project</h2>
      <div class="field"><label>Project name</label><input name="name" required minlength="2" /></div>
      <div class="field"><label>Description</label><textarea name="description"></textarea></div>
      <div class="field">
        <label>Team members</label>
        <select class="multi-select" name="memberIds" multiple>
          ${state.users.map((user) => `<option value="${user.id}">${escapeHtml(user.name)} (${user.role})</option>`).join("")}
        </select>
      </div>
      <button class="primary" type="submit">Create project</button>
    </form>
  `;
}

function taskForm() {
  if (!state.projectDetails) return "";
  const members = state.projectDetails.members || [];
  const assigneeOptions = members
    .filter((member) => state.user.role === "admin" || member.id === state.user.id)
    .map((member) => `<option value="${member.id}">${escapeHtml(member.name)}</option>`)
    .join("");

  return `
    <form class="form" id="task-form">
      <h2>New Task</h2>
      <input type="hidden" name="projectId" value="${state.currentProject}" />
      <div class="field"><label>Title</label><input name="title" required minlength="2" /></div>
      <div class="field"><label>Description</label><textarea name="description"></textarea></div>
      <div class="field"><label>Assignee</label><select name="assigneeId">${state.user.role === "admin" ? `<option value="">Unassigned</option>` : ""}${assigneeOptions}</select></div>
      <div class="field"><label>Priority</label><select name="priority"><option value="medium">Medium</option><option value="high">High</option><option value="low">Low</option></select></div>
      <div class="field"><label>Due date</label><input name="dueDate" type="date" /></div>
      <button class="primary" type="submit">Add task</button>
    </form>
  `;
}

function dashboard() {
  const summary = state.dashboard?.summary || {};
  const items = [
    ["total", "Total"],
    ["todo", "To do"],
    ["in_progress", "In progress"],
    ["done", "Done"],
    ["overdue", "Overdue"]
  ];
  return `<section class="metrics">${items.map(([key, label]) => `
    <div class="metric"><strong>${summary[key] || 0}</strong><span>${label}</span></div>
  `).join("")}</section>`;
}

function projectList() {
  if (!state.projects.length) return `<div class="notice">No projects yet.</div>`;
  return `<div class="list">${state.projects.map((project) => `
    <button class="project-row ${state.currentProject === project.id ? "active" : ""}" data-project="${project.id}">
      <h3>${escapeHtml(project.name)}</h3>
      <p>${escapeHtml(project.description || "No description")}</p>
      <div class="meta"><span class="tag">${project.member_count} members</span><span class="tag">Owner: ${escapeHtml(project.owner_name)}</span></div>
    </button>
  `).join("")}</div>`;
}

function taskList() {
  const details = state.projectDetails;
  if (!details) return `<div class="notice">Select a project to view tasks.</div>`;
  if (!details.tasks.length) return `<div class="notice">No tasks in this project yet.</div>`;

  return `<div class="task-grid">${details.tasks.map((task) => `
    <article class="task-card">
      <div>
        <h3>${escapeHtml(task.title)}</h3>
        <p>${escapeHtml(task.description || "No description")}</p>
      </div>
      <div class="meta">
        <span class="tag ${task.status}">${statusLabels[task.status]}</span>
        <span class="tag ${task.priority}">${task.priority}</span>
        ${task.due_date ? `<span class="tag ${isOverdue(task) ? "overdue" : ""}">Due ${task.due_date.slice(0, 10)}</span>` : ""}
        <span class="tag">${escapeHtml(task.assignee_name || "Unassigned")}</span>
      </div>
      <div class="task-actions">
        <select data-status="${task.id}" ${state.user.role !== "admin" && task.assignee_id !== state.user.id ? "disabled" : ""}>
          ${Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${task.status === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </div>
    </article>
  `).join("")}</div>`;
}

function appView() {
  app.innerHTML = `
    <section class="app-shell">
      <header class="topbar">
        <div>
          <h1>Team Task Manager</h1>
          <div class="muted">Projects, assignments, status, and overdue work in one place.</div>
        </div>
        <div class="user-pill">
          <span>${escapeHtml(state.user.name)}</span>
          <span class="role">${state.user.role}</span>
          <button class="ghost" id="logout">Logout</button>
        </div>
      </header>
      <div class="content">
        <aside class="sidebar">
          ${projectForm()}
          ${taskForm()}
        </aside>
        <section class="main">
          ${dashboard()}
          <div class="workspace">
            <section>
              <div class="toolbar"><h2>Projects</h2>${projectList()}</div>
            </section>
            <section>
              <div class="toolbar">
                <h2>${escapeHtml(state.projectDetails?.project?.name || "Tasks")}</h2>
                ${taskList()}
              </div>
            </section>
          </div>
        </section>
      </div>
    </section>
  `;

  app.querySelector("#logout").addEventListener("click", logout);
  app.querySelector("#project-form")?.addEventListener("submit", createProject);
  app.querySelector("#task-form")?.addEventListener("submit", createTask);
  app.querySelectorAll("[data-project]").forEach((button) => {
    button.addEventListener("click", () => loadProject(button.dataset.project));
  });
  app.querySelectorAll("[data-status]").forEach((select) => {
    select.addEventListener("change", () => updateStatus(select.dataset.status, select.value));
  });
}

function render() {
  if (!state.token || !state.user) authView();
  else appView();
}

render();
loadApp().then(render);
