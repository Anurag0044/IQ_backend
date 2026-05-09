# CloudIQ Backend .......

Express.js backend for CloudIQ with IBM App ID authentication, Cloudant data storage, and AI/voice integrations.

## AI Prompting (copy-paste friendly)
- Purpose: Backend API for auth, social, tutorials, AI chat, and voice transcription.
- Entry point: server.js (Express app, session, Passport App ID, routes, Socket.IO).
- Auth: IBM App ID via Passport; session cookies; /auth/login -> /auth/callback; /auth/user returns session state.
- Key modules: middleware/auth.js (ensureAuthenticated, ensureAdmin), services/adminDb.js (admin role checks), utils/db.js (Cloudant access).
- Route groups: routes/auth.js, routes/user.js, routes/posts.js, routes/comments.js, routes/friends.js, routes/notifications.js, routes/tutorials.js, routes/orion.js, routes/voice.js, routes/admin.js.

## Features
- IBM App ID OAuth2 login with session cookies
- Role-based access (admin/user)
- Social feed: posts, comments, likes
- Friends and notifications
- Tutorials and quizzes
- Orion AI chat (NVIDIA NIM)
- Voice transcription (IBM Watson STT)
- Real-time notifications via Socket.IO

## Tech Stack
- Node.js, Express, Passport
- IBM App ID, IBM Cloudant, IBM Watson STT
- Socket.IO, Cloudinary, Multer
- LangChain + DuckDuckGo search for RAG

## Setup
1) Install dependencies
```bash
npm install
```

2) Create .env from the template
```bash
copy .env.example .env
```

3) Start the server
```bash
npm run dev
```

The server defaults to http://localhost:5000.

## Scripts
- npm run dev: start with nodemon
- npm start: start with node

## Environment Variables
From .env.example:

Server and session
- PORT
- NODE_ENV
- SESSION_SECRET
- FRONTEND_URL

IBM App ID
- APPID_TENANT_ID
- APPID_CLIENT_ID
- APPID_SECRET
- APPID_OAUTH_SERVER_URL
- APPID_REDIRECT_URI
- APPID_DISCOVERY_ENDPOINT
- APPID_PROFILES_URL
- APPID_MANAGEMENT_URL
- APPID_API_KEY
- ADMIN_ROLE_ID
- ADMIN_ROLE_NAME

Orion AI (NVIDIA NIM)
- ORION_API_KEY
- ORION_MODEL
- ORION_VISION_MODEL
- ORION_API_TIMEOUT_MS

## Auth Flow
1) Frontend redirects to /auth/login
2) IBM App ID handles login and returns to /auth/callback
3) Server creates a session and redirects to /dashboard (or /admin)
4) Frontend calls /auth/user on every load to sync auth state

## API Overview
This is a high-level map. See route files for exact endpoints.

Auth
- /auth/login
- /auth/callback
- /auth/logout
- /auth/user
- /auth/status

Core API
- /api/user
- /api/posts
- /api/comments
- /api/friends
- /api/notifications
- /api/tutorials
- /api/orion
- /api/voice
- /api/admin

## How It Fits Together
- Frontend base URL is FRONTEND_URL for redirects and CORS.
- Session cookies are used for authenticated requests.
- /auth/user returns JSON (never 401) so the frontend can handle logged-out state.

## Notes
- Orion AI uses NVIDIA NIM. Set ORION_API_KEY and a full NVIDIA model id such as moonshotai/kimi-k2-instruct.
- Voice transcription requires IBM Watson STT credentials.
- Admin roles are checked against Cloudant and ADMIN_ROLE_NAME/ADMIN_ROLE_ID.

## GitHub Codespaces Labs

CloudIQ Labs lets an authenticated CloudIQ user connect GitHub, paste a public GitHub repository URL, and launch a temporary GitHub Codespace. IBM App ID remains the primary CloudIQ login; GitHub OAuth is added only for Codespaces API access.

### Exact npm packages

Backend packages:

```bash
npm install passport-github2 axios node-cron uuid
```

These packages are already listed in this backend package.json:

- `passport-github2` for GitHub OAuth
- `axios` for GitHub REST API calls
- `node-cron` for 5 minute cleanup
- `uuid` for lab session ids

Frontend package:

```bash
cd ../ibm_project
npm install axios
```

### Backend file structure

New or updated backend files:

- `routes/githubAuth.js` - separate GitHub OAuth connect/status/logout routes
- `routes/labs.js` - lab create/list/delete APIs
- `middleware/githubAuth.js` - GitHub session middleware/helpers
- `services/githubCodespacesService.js` - GitHub repo validation, Codespaces create/delete, token encryption
- `services/labCleanupService.js` - node-cron cleanup every 5 minutes
- `services/cloudantClient.js` - adds `lab_sessions` database and lab design doc
- `server.js` - mounts `/api/github`, `/api/labs`, starts/stops cleanup service

### Environment variables

Add these to the backend `.env`:

```env
FRONTEND_URL=http://localhost:5173
BACKEND_URL=http://localhost:5000

GITHUB_CLIENT_ID=your-github-oauth-client-id
GITHUB_CLIENT_SECRET=your-github-oauth-client-secret
GITHUB_CALLBACK_URL=http://localhost:5000/api/github/callback
GITHUB_API_VERSION=2026-03-10

LAB_TTL_MINUTES=30
LAB_TOKEN_ENCRYPTION_KEY=replace-with-a-long-random-secret-used-only-for-lab-token-encryption
```

Keep the existing IBM App ID, Cloudant, Firebase, and session variables unchanged. `LAB_TOKEN_ENCRYPTION_KEY` is used to encrypt the GitHub access token stored with a lab so the scheduled cleanup can really delete expired Codespaces after the browser session is gone. The encrypted token is never returned by the API.

### GitHub OAuth app setup

Create the OAuth app at GitHub Developer settings:

1. Go to GitHub -> Settings -> Developer settings -> OAuth Apps -> New OAuth App.
2. Homepage URL for local dev: `http://localhost:5173`.
3. Authorization callback URL for local dev: `http://localhost:5000/api/github/callback`.
4. For Render, set callback to `https://your-render-backend.onrender.com/api/github/callback`.
5. Put the generated Client ID and Client Secret into `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

Required scopes requested by the backend:

- `codespace` - create and delete Codespaces
- `read:user` - identify the connected GitHub account

### Cloudant setup

Create the database if it does not already exist:

```text
lab_sessions
```

The backend also ensures this database on startup through `services/cloudantClient.js`.

Stored lab document shape:

```json
{
  "_id": "uuid",
  "user_id": "ibm-app-id-sub",
  "repo_url": "https://github.com/user/repo",
  "repo_name": "user/repo",
  "codespace_name": "codespace-name",
  "web_url": "https://...",
  "status": "active",
  "created_at": "2026-05-10T00:00:00.000Z",
  "expires_at": "2026-05-10T00:30:00.000Z"
}
```

The server also stores internal encrypted cleanup metadata on the document. API responses remove secrets and `_rev`.

### Backend routes

GitHub OAuth:

- `GET /api/github/login` - starts GitHub OAuth, requires existing IBM App ID session
- `GET /api/github/callback` - saves GitHub access token in session
- `GET /api/github/status` - returns connection state
- `POST /api/github/logout` - removes GitHub connection from session

Labs:

- `GET /api/labs` - list the current user's labs and active lab
- `POST /api/labs/create` - validate public repo, create Codespace, store active lab
- `DELETE /api/labs` - delete the current user's active lab
- `DELETE /api/labs/:labId` - delete only the current user's matching lab

Create request:

```json
{
  "repoUrl": "https://github.com/user/repo"
}
```

Successful create response includes:

```json
{
  "success": true,
  "web_url": "https://...",
  "data": {
    "_id": "uuid",
    "repo_name": "user/repo",
    "status": "active",
    "expires_at": "..."
  }
}
```

### Codespaces behavior

The backend uses the real GitHub REST API:

- `GET /repos/{owner}/{repo}` to fetch repository details
- `POST /repos/{owner}/{repo}/codespaces` to create the Codespace
- `DELETE /user/codespaces/{codespace_name}` to delete the Codespace

Private repositories are rejected even if the connected GitHub user can access them. Only one `active` lab is allowed per CloudIQ user. Labs expire after `LAB_TTL_MINUTES`, default `30`.

### Cleanup system

`services/labCleanupService.js` runs every 5 minutes:

1. Finds `active` labs where `expires_at <= now`.
2. Decrypts the stored GitHub token.
3. Deletes the GitHub Codespace.
4. Updates the Cloudant document to `status: "expired"`.

On backend shutdown, `server.js` stops the cron scheduler before closing the HTTP server.

### Render deployment notes

Set these Render environment variables:

```env
NODE_ENV=production
FRONTEND_URL=https://your-netlify-site.netlify.app
BACKEND_URL=https://your-render-backend.onrender.com
GITHUB_CALLBACK_URL=https://your-render-backend.onrender.com/api/github/callback
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
LAB_TOKEN_ENCRYPTION_KEY=...
```

Also keep existing IBM App ID callback URLs and Cloudant credentials configured. Because cross-site cookies are used between Netlify and Render, keep the existing production session cookie settings in `server.js`.

### Frontend file structure

New or updated frontend files in `../ibm_project`:

- `src/pages/Labs.jsx`
- `src/pages/Labs.css`
- `src/services/api.js`
- `src/App.jsx`
- `src/components/Sidebar.jsx`

The new `/labs` page includes:

- GitHub connect button
- public repo URL input
- launch button with loading state
- active lab card
- countdown timer
- expiration timestamp
- open Codespace button
- delete lab button
- error and success messages
- multiple-lab prevention in the UI

### Frontend API examples

Axios setup in `src/services/api.js`:

```js
export const axiosClient = axios.create({
  baseURL: API_URL || undefined,
  withCredentials: true,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});
```

Launch handler:

```js
const result = await createLab(repoUrl.trim());
if (result.success && result.web_url) {
  window.open(result.web_url, '_blank', 'noopener,noreferrer');
}
```

Delete handler:

```js
const result = await deleteLab(activeLab._id);
if (result.success) setActiveLab(null);
```

Timer implementation:

```js
const next = new Date(expiresAt).getTime() - Date.now();
setRemaining(next);
```

### Netlify deployment notes

Set the frontend environment variables:

```env
VITE_BACKEND_URL=https://your-render-backend.onrender.com
VITE_API_URL=https://your-render-backend.onrender.com
```

If using a Netlify proxy instead of direct backend calls, keep `VITE_API_URL` empty and proxy `/api/*` and `/auth/*` to Render. OAuth redirects must use `VITE_BACKEND_URL` so browser redirects go directly to the backend.

### Local testing

1. Start backend:

```bash
cd ibm_backend
npm run dev
```

2. Start frontend:

```bash
cd ../ibm_project
npm run dev
```

3. Log in through IBM App ID as usual.
4. Open `/labs`.
5. Click `Connect GitHub`.
6. Paste a public repo URL, for example `https://github.com/octocat/Hello-World`.
7. Click `Launch`.
8. Confirm a Codespace opens in a new tab.
9. Refresh `/labs` and confirm the active lab persists.
10. Click `Delete lab` and confirm GitHub Codespaces no longer shows it.
11. To test expiration, temporarily set `LAB_TTL_MINUTES=1`, create a lab, wait for the cron tick, and confirm Cloudant changes status to `expired`.

### Server.js modifications

The labs system adds only these server-level changes:

- imports `startLabCleanupService` and `stopLabCleanupService`
- mounts `app.use("/api/github", githubAuthRoutes)`
- mounts `app.use("/api/labs", labsRoutes)`
- calls `startLabCleanupService()` after the server starts
- registers `SIGTERM` and `SIGINT` handlers to stop cleanup gracefully

IBM App ID auth, existing community/discussion/tutorial/admin routes, and Socket.IO handlers are left in place.
