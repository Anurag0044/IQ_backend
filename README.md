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
- Orion AI chat (Ollama + RAG)
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

Orion AI (Ollama)
- OLLAMA_BASE_URL
- ORION_REQUIRE_NGROK
- ORION_PRIMARY_MODEL
- ORION_FALLBACK_MODEL
- ORION_LOGIC_MODEL

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
- Orion AI requires a reachable Ollama endpoint (often via ngrok).
- Voice transcription requires IBM Watson STT credentials.
- Admin roles are checked against Cloudant and ADMIN_ROLE_NAME/ADMIN_ROLE_ID.
