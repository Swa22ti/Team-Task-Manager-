# Team Task Manager

A full-stack task management app for teams. Users can sign up, log in, create projects, assign tasks, update task status, and track dashboard progress with Admin/Member role-based access.

## Features

- Authentication with JWT signup/login
- Admin and Member roles
- Admin project and team management
- Task creation with assignee, priority, due date, and status
- Member access limited to assigned projects and assigned task updates
- Dashboard metrics for total, to do, in progress, done, and overdue tasks
- REST API backed by PostgreSQL
- Railway-ready single service deployment

## Tech Stack

- Node.js
- Express
- PostgreSQL
- JWT
- bcryptjs
- Zod validation
- Vanilla HTML/CSS/JavaScript frontend

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

3. Set `DATABASE_URL` to a PostgreSQL database and set a strong `JWT_SECRET`.

4. Start the app:

```bash
npm run dev
```

5. Open `http://localhost:3000`.

The database tables are created automatically when the server starts.

## Railway Deployment

1. Push this project to GitHub.
2. Create a new Railway project from the GitHub repo.
3. Add a Railway PostgreSQL database.
4. In the web service variables, add:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=your-long-random-secret
NODE_ENV=production
```

5. Deploy. Railway will run `npm start`.

## API Overview

### Auth

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/me`

### Users

- `GET /api/users`

### Projects

- `GET /api/projects`
- `POST /api/projects` Admin only
- `GET /api/projects/:id`
- `PATCH /api/projects/:id/members` Admin only

### Tasks

- `POST /api/tasks`
- `PATCH /api/tasks/:id/status`

### Dashboard

- `GET /api/dashboard`

## Roles

Admins can create projects, manage project members, assign work to any project member, and update all visible tasks.

Members can view projects where they are team members, create tasks assigned to themselves, and update only their assigned tasks.

## Submission Checklist

- Live URL: add your Railway app URL here
- GitHub repo: add your repository URL here
- README: included
- Demo video: record a 2-5 minute walkthrough covering signup/login, admin project creation, task assignment, member login, status update, and dashboard metrics
