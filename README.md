# CloudIQ Backend

Production-ready Express backend for CloudIQ: authentication, communities, realtime discussions, brainstorming, Orion AI, Firebase persistence, Cloudinary media, GitHub OAuth, and GitHub Codespaces-powered labs.

## Table of Contents

- [1. Project Overview](#1-project-overview)
- [2. Core Features](#2-core-features)
- [3. Backend Architecture](#3-backend-architecture)
- [4. Installation Guide](#4-installation-guide)
- [5. Environment Variables](#5-environment-variables)
- [6. Firebase Admin Setup](#6-firebase-admin-setup)
- [7. Cloudinary Media System](#7-cloudinary-media-system)
- [8. GitHub Integration](#8-github-integration)
- [9. Orion AI System](#9-orion-ai-system)
- [10. Socket.IO](#10-socketio)
- [11. Deployment Guide](#11-deployment-guide)
- [12. Security](#12-security)
- [13. Performance Optimization](#13-performance-optimization)
- [14. Troubleshooting](#14-troubleshooting)
- [15. API Documentation](#15-api-documentation)
- [16. Contributing Guide](#16-contributing-guide)

---

## 1. Project Overview

CloudIQ Backend is the API and realtime server for the CloudIQ learning platform. It connects the frontend to authentication, community data, media uploads, Firebase persistence, Orion AI, GitHub repository workflows, and GitHub Codespaces lab environments.

The backend is designed around a practical split:

- **REST APIs** handle authenticated CRUD workflows, media uploads, labs, communities, tutorials, posts, and AI generation.
- **Socket.IO** handles realtime events for discussions, typing indicators, presence, whiteboard updates, and post/community notifications.
- **Firebase Admin** persists realtime discussion data, brainstorm room metadata, lab sessions, and whiteboard state.
- **Cloudinary** stores images, videos, raw discussion attachments, post media, tutorial media, and user profile images.
- **GitHub OAuth and Codespaces APIs** connect user GitHub accounts, list repositories, and launch cloud lab environments.
- **Orion AI** powers chat and the CloudIQ Brainstorming experience with frontend-safe structured JSON responses.

### High-Level System Diagram

```text
                         +----------------------+
                         |   CloudIQ Frontend   |
                         | React / Vite / SPA   |
                         +----------+-----------+
                                    |
                    HTTPS REST + Cookie Sessions + Socket.IO
                                    |
                         +----------v-----------+
                         |   CloudIQ Backend    |
                         | Node.js + Express    |
                         +----------+-----------+
                                    |
       +----------------------------+-----------------------------+
       |                            |                             |
+------v-------+            +-------v------+              +-------v------+
| Firebase     |            | Cloudinary   |              | GitHub APIs  |
| Firestore    |            | Media CDN    |              | OAuth/Repos  |
| RTDB         |            | Uploads      |              | Codespaces   |
+------+-------+            +-------+------+              +------+-------+
       |                            |                            |
       +----------------------------+----------------------------+
                                    |
                         +----------v-----------+
                         | Orion / NVIDIA NIM   |
                         | AI Chat + Brainstorm |
                         +----------------------+
```

### Main Responsibilities

| Area | What the backend does |
| --- | --- |
| Auth | IBM App ID login/logout, sessions, role checks, admin access |
| Communities | Create, update, join, leave, request, approve, and reject community access |
| Discussions | Channels, messages, media, reactions, unread state, pinning, realtime delivery |
| Brainstorming | Rooms, whiteboard sync, notes, connectors, Orion AI idea generation |
| Labs | GitHub repository validation, Codespaces creation/deletion, lab sessions |
| Media | Profile images, posts, tutorials, discussion uploads, videos, cleanup |
| AI | Orion chat streaming and structured brainstorming generation |
| Realtime | Socket.IO presence, typing, posts, discussions, and whiteboard events |

---

## 2. Core Features

### Orion AI APIs

- Streaming Orion chat through `/api/orion/chat`.
- NVIDIA NIM-compatible provider support.
- Structured Brainstorming generation through `/api/brainstorm/ai/generate`.
- Safe JSON responses for frontend rendering.
- Timeout handling, provider failure handling, scoped logging, and prompt validation.

### Brainstorming APIs

- Create and manage brainstorm rooms.
- Join and leave collaborative rooms.
- Persist whiteboard state in Firebase Realtime Database.
- Store room metadata and AI generations in Firestore.
- Generate one optimized structured idea at a time for fast UI previews.
- Add sticky notes and connectors.

### Realtime Discussions

- Community channel list.
- Channel creation and deletion.
- Message history.
- Media messages.
- Typing indicators.
- Presence updates.
- Reactions, unread state, and pinned messages.
- Explicit socket errors instead of silent failures.

### Firebase Persistence

- Firestore stores discussions, messages, channels, brainstorm sessions, AI generations, labs, lab sessions, presence, reactions, unread states, and metadata.
- Realtime Database stores live whiteboard state for Brainstorming rooms.
- Admin SDK singleton initialization prevents duplicate app initialization.

### Cloudinary Media Uploads

- Buffer-only uploads using `multer.memoryStorage`.
- Image, video, and raw file support.
- Discussion attachments organized by community/channel.
- Tutorial media uploads and cleanup.
- Post media uploads and cleanup.
- Profile image uploads and cleanup.

### GitHub OAuth and Repository APIs

- GitHub OAuth connection per authenticated user.
- Repository listing for public and private repositories.
- Access-token-backed GitHub API requests.
- Handles organization access restrictions, SSO/SAML restrictions, and rate limits.

### Codespaces Management

- Launch GitHub Codespaces from repository URLs.
- Validate repository URL, branch/ref, owner, and repo.
- Store lab state and sessions.
- Delete Codespaces and clean up active lab locks.
- Supports custom display names for labs.

### Socket.IO Realtime Events

- User socket registration.
- Duplicate socket prevention.
- Discussion channel joins and message delivery.
- Typing start/stop.
- Whiteboard room join/leave/sync/clear.
- Sticky note and connector events.
- Presence updates and disconnect cleanup.

### Labs System

- Create cloud lab sessions.
- Track active, expired, and deleted labs.
- Cleanup expired lab sessions.
- Release active lock/session state after delete.
- Surface GitHub/Codespaces errors with frontend-safe JSON.

### Community APIs

- Public and private communities.
- Membership requests.
- Owner/admin approval workflows.
- Member access checks.
- Notifications on requests and approvals.

---

## 3. Backend Architecture

### Request Lifecycle

```text
Client Request
    |
    v
Express Middleware
    |-- helmet
    |-- cors
    |-- express.json/urlencoded
    |-- session
    |-- passport
    |-- auth guards
    v
Route Handler
    |
    v
Service Layer
    |-- Firebase Admin
    |-- Cloudinary
    |-- Cloudant
    |-- GitHub API
    |-- Orion AI
    v
Safe JSON Response / Socket.IO Event
```

### Folder Structure

```text
cloudiq-backend/
|-- server.js                         # Express app, Socket.IO server, route mounts
|-- package.json                      # Scripts and dependencies
|-- config/
|   |-- appid.js                      # IBM App ID configuration helper
|   `-- session.js                    # Express session configuration
|-- middleware/
|   |-- auth.js                       # Session/auth helpers and role checks
|   |-- authMiddleware.js             # Additional auth middleware
|   `-- githubAuth.js                 # GitHub OAuth middleware
|-- routes/
|   |-- admin.js                      # Admin dashboard/admin management APIs
|   |-- auth.js                       # IBM App ID auth routes
|   |-- brainstorm.js                 # Brainstorm rooms, whiteboard REST, Orion generation
|   |-- comments.js                   # Post comments
|   |-- community.js                  # Communities, joins, requests, approvals
|   |-- discussions.js                # Channels, messages, media, reactions, unreads
|   |-- friends.js                    # Friend discovery and requests
|   |-- githubAuth.js                 # GitHub OAuth and repo listing
|   |-- labs.js                       # GitHub Codespaces lab lifecycle
|   |-- notifications.js              # User notifications
|   |-- orion.js                      # Orion streaming chat
|   |-- posts.js                      # Feed posts and media
|   |-- tutorials.js                  # Tutorial CRUD and tutorial media
|   |-- user.js                       # Profile, dashboard, onboarding, account
|   `-- voice.js                      # IBM Watson speech-to-text
|-- services/
|   |-- adminDb.js                    # Admin role persistence
|   |-- brainstormService.js          # Brainstorm room and Orion AI business logic
|   |-- cacheService.js               # In-memory caches
|   |-- cloudantClient.js             # IBM Cloudant client wrapper
|   |-- cloudinaryService.js          # Buffer-only Cloudinary uploads and cleanup
|   |-- firebaseService.js            # Firebase Admin, Firestore, Realtime Database
|   |-- githubCodespacesService.js    # GitHub repo and Codespaces API logic
|   |-- labCleanupService.js          # Expired lab cleanup job
|   |-- mediaService.js               # Media helpers
|   |-- notificationService.js        # Notifications
|   `-- statsService.js               # Realtime stats broadcaster
|-- sockets/
|   |-- discussions.js                # Discussion Socket.IO handlers
|   `-- whiteboard.js                 # Brainstorm whiteboard Socket.IO handlers
|-- utils/
|   |-- db.js                         # Cloudant/user helper utilities
|   `-- logger.js                     # Level-based structured logging and redaction
`-- firestore.indexes.json            # Firestore indexes
```

### Architecture Layers

| Layer | Responsibility |
| --- | --- |
| `server.js` | App bootstrap, middleware, sessions, Socket.IO, global route mounts |
| `routes/*` | HTTP input validation, auth checks, REST response shaping |
| `services/*` | Business logic and third-party API boundaries |
| `middleware/*` | Auth, role, session, OAuth helpers |
| `sockets/*` | Realtime event handling and socket authorization |
| `utils/*` | Shared database and logging utilities |

---

## 4. Installation Guide

### Prerequisites

- Node.js 20 LTS recommended
- npm 10+
- Firebase project with a service account
- Cloudinary account
- IBM App ID service
- IBM Cloudant instance
- GitHub OAuth app
- GitHub account with Codespaces access
- Orion/NVIDIA API key

### Clone the Repository

```bash
git clone <your-repository-url>
cd ibm_backend
```

### Install Dependencies

```bash
npm install
```

### Create Environment File

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

If `.env.example` does not exist, create `.env` manually using the environment table below.

### Run in Development

```bash
npm run dev
```

### Run in Production Mode

```bash
npm start
```

### Health Check

```bash
curl <BACKEND_URL>/
```

Expected response:

```json
{
  "service": "CloudIQ Backend",
  "status": "running",
  "timestamp": "2026-05-10T00:00:00.000Z"
}
```

---

## 5. Environment Variables

Use a real `.env` file locally and secure environment variables in production.

### Server and Runtime

| Variable | Required | Example | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | Recommended | `development` or `production` | Controls secure cookies, debug behavior, and stack trace exposure. |
| `PORT` | No | `5000` | Backend port. Defaults to `5000`. |
| `FRONTEND_URL` | Yes | `<FRONTEND_URL>` | Frontend origin for CORS and auth redirects. |
| `BACKEND_URL` | Recommended | `https://api.example.com` | Public backend URL used by GitHub OAuth callback helpers. |
| `SESSION_SECRET` | Yes | `change-me-long-random-secret` | Express session signing secret. Use a long random value in production. |
| `LOG_LEVEL` | No | `info` | Logging level: `debug`, `info`, `warn`, or `error`. |
| `JSON_BODY_LIMIT` | No | `1mb` | Express JSON body limit. |
| `FORM_BODY_LIMIT` | No | `1mb` | URL-encoded body limit. |

### IBM App ID Authentication

| Variable | Required | Example | Description |
| --- | --- | --- | --- |
| `APPID_TENANT_ID` | Yes | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | IBM App ID tenant ID. |
| `APPID_CLIENT_ID` | Yes | `client-id` | IBM App ID client ID. |
| `APPID_SECRET` | Yes | `client-secret` | IBM App ID client secret. |
| `APPID_OAUTH_SERVER_URL` | Yes | `https://...appid.cloud.ibm.com/oauth/v4/...` | IBM App ID OAuth server URL. |
| `APPID_REDIRECT_URI` | Yes | `<BACKEND_URL>/auth/callback` | Redirect URI configured in IBM App ID. |
| `ADMIN_ROLE_NAME` | No | `admin` | Role name used for admin detection in some auth paths. |
| `ADMIN_EMAILS` | Recommended | `admin@example.com,owner@example.com` | Super admin email allowlist. |

### IBM Watson

| Variable | Required | Example | Description |
| --- | --- | --- | --- |
| `WATSON_STT_API_KEY` | Required for voice | `watson-key` | IBM Watson Speech-to-Text API key. |
| `WATSON_STT_URL` | Required for voice | `https://api.us-south.speech-to-text.watson.cloud.ibm.com` | IBM Watson Speech-to-Text service URL. |
| `IBM_API_KEY` | Optional | `ibm-cloud-api-key` | Optional general IBM Cloud API key if future IBM services require it. Current voice code uses `WATSON_STT_API_KEY`. |

### Firebase Admin

| Variable | Required | Example | Description |
| --- | --- | --- | --- |
| `FIREBASE_PROJECT_ID` | Yes | `cloudiq-prod` | Firebase project ID. |
| `FIREBASE_CLIENT_EMAIL` | Yes | `firebase-adminsdk-...@cloudiq-prod.iam.gserviceaccount.com` | Service account client email. |
| `FIREBASE_PRIVATE_KEY` | Yes | `"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"` | Service account private key. Keep quotes and escaped newlines in `.env`. |
| `FIREBASE_DATABASE_URL` | Recommended | `https://cloudiq-prod-default-rtdb.firebaseio.com` | Realtime Database URL for whiteboard sync. |
| `VITE_FIREBASE_DATABASE_URL` | Optional fallback | `https://cloudiq-prod-default-rtdb.firebaseio.com` | Backward-compatible fallback for database URL. |
| `FIRESTORE_DEBUG_ROUTE_ENABLED` | No | `true` | Enables `/api/debug/firestore` in production when set to `true`. |

### Cloudinary

| Variable | Required | Example | Description |
| --- | --- | --- | --- |
| `CLOUDINARY_CLOUD_NAME` | Yes | `cloudiq` | Cloudinary cloud name. |
| `CLOUDINARY_API_KEY` | Yes | `1234567890` | Cloudinary API key. |
| `CLOUDINARY_API_SECRET` | Yes | `cloudinary-secret` | Cloudinary API secret. |

### GitHub OAuth and Codespaces

| Variable | Required | Example | Description |
| --- | --- | --- | --- |
| `GITHUB_CLIENT_ID` | Required for GitHub OAuth | `github-oauth-client-id` | GitHub OAuth app client ID. |
| `GITHUB_CLIENT_SECRET` | Required for GitHub OAuth | `github-oauth-secret` | GitHub OAuth app client secret. |
| `GITHUB_CALLBACK_URL` | Recommended | `<BACKEND_URL>/api/github/callback` | GitHub OAuth callback URL. |
| `GITHUB_API_VERSION` | No | `2026-03-10` | GitHub REST API version header. |
| `LAB_TOKEN_ENCRYPTION_KEY` | Recommended | `32-byte-secret` | Secret used to encrypt lab/GitHub token data. Falls back to `SESSION_SECRET`. |
| `LAB_TTL_MINUTES` | No | `120` | Default active lab lifetime before cleanup. |

### Cloudant

| Variable | Required | Example | Description |
| --- | --- | --- | --- |
| `CLOUDANT_APIKEY` | Yes | `cloudant-api-key` | IBM Cloudant API key. |
| `CLOUDANT_URL` | Yes | `https://...cloudantnosqldb.appdomain.cloud` | IBM Cloudant service URL. |

### Orion AI / NVIDIA NIM

| Variable | Required | Example | Description |
| --- | --- | --- | --- |
| `ORION_API_KEY` | Required for Orion | `nvapi-...` | Primary Orion/NVIDIA API key. |
| `NVIDIA_API_KEY` | Optional fallback | `nvapi-...` | Alternative API key variable. |
| `NVIDIA_NIM_API_KEY` | Optional fallback | `nvapi-...` | Alternative NVIDIA NIM API key variable. |
| `NVIDIA_API_URL` | No | `https://integrate.api.nvidia.com/v1/chat/completions` | Chat completions endpoint. |
| `ORION_MODEL` | No | `moonshotai/kimi-k2-instruct` | Text model for Orion chat and brainstorming. |
| `ORION_VISION_MODEL` | No | `meta/llama-3.2-11b-vision-instruct` | Vision-capable Orion chat model. |
| `ORION_API_TIMEOUT_MS` | No | `60000` | Provider request timeout in milliseconds. |
| `ORION_MAX_QUERY_CHARS` | No | `12000` | Max chat query length. |
| `ORION_MAX_DOCUMENT_CHARS` | No | `60000` | Max document text length for Orion chat. |
| `ORION_MAX_IMAGES` | No | `4` | Max images accepted by Orion chat. |
| `ORION_BRAINSTORM_PROMPT_CHARS` | No | `1800` | Prompt length sent to brainstorming Orion generation. |
| `ORION_BRAINSTORM_MAX_TOKENS` | No | `900` | Max provider tokens for brainstorming generation. |

### Example `.env`

```env
NODE_ENV=development
PORT=5000
FRONTEND_URL=<FRONTEND_URL>
BACKEND_URL=<BACKEND_URL>
SESSION_SECRET=replace-with-a-long-random-secret
LOG_LEVEL=debug

APPID_TENANT_ID=
APPID_CLIENT_ID=
APPID_SECRET=
APPID_OAUTH_SERVER_URL=
APPID_REDIRECT_URI=<BACKEND_URL>/auth/callback
ADMIN_EMAILS=admin@example.com

FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=

CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

CLOUDANT_APIKEY=
CLOUDANT_URL=

GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=<BACKEND_URL>/api/github/callback
GITHUB_API_VERSION=2026-03-10
LAB_TOKEN_ENCRYPTION_KEY=
LAB_TTL_MINUTES=120

ORION_API_KEY=
ORION_MODEL=moonshotai/kimi-k2-instruct
ORION_API_TIMEOUT_MS=60000
ORION_BRAINSTORM_PROMPT_CHARS=1800
ORION_BRAINSTORM_MAX_TOKENS=900

WATSON_STT_API_KEY=
WATSON_STT_URL=
```

---

## 6. Firebase Admin Setup

CloudIQ uses `firebase-admin` on the backend. The Admin SDK is initialized once in `services/firebaseService.js`.

### What Firebase Stores

| Firebase product | Usage |
| --- | --- |
| Firestore | Discussion channels, messages, reactions, unread states, presence, brainstorm rooms, AI generations, labs, lab sessions |
| Realtime Database | Live whiteboard state for Brainstorming rooms |

### Setup Steps

1. Open the Firebase Console.
2. Create or select a Firebase project.
3. Enable Firestore.
4. Enable Realtime Database if using Brainstorm whiteboard sync.
5. Go to **Project Settings > Service Accounts**.
6. Generate a new private key.
7. Copy `project_id`, `client_email`, and `private_key` into `.env`.
8. Keep the private key escaped as `\n` inside environment variables.

### Singleton Initialization

The service checks `admin.apps.length` before initializing:

```js
if (admin.apps.length === 0) {
  firebaseApp = admin.initializeApp({ credential, databaseURL });
} else {
  firebaseApp = admin.apps[0];
}
```

This prevents duplicate Firebase app initialization during local reloads or test runs.

### Firestore Debug Route

Local and controlled production debugging:

```http
GET /api/debug/firestore
```

In production, set this only when needed:

```env
FIRESTORE_DEBUG_ROUTE_ENABLED=true
```

Disable it again after debugging.

---

## 7. Cloudinary Media System

CloudIQ uses Cloudinary for user-generated media. Uploads are handled from memory buffers only, avoiding brittle temp-file paths.

### Media Types

| Area | Media handled |
| --- | --- |
| Discussions | Images, videos, documents, raw attachments |
| Posts | Images and videos |
| Tutorials | Cover images, inline images, inline videos |
| Users | Profile images |

### Upload Flow

```text
Frontend FormData
    |
    v
multer.memoryStorage()
    |
    v
req.file.buffer
    |
    v
cloudinary.uploader.upload_stream()
    |
    v
Cloudinary secure_url + public_id
    |
    v
Firestore/Cloudant metadata
```

### Discussion Upload Contract

```http
POST /api/discussions/channels/:channelId/media
Content-Type: multipart/form-data
```

Form field:

```text
file
```

Frontend example:

```js
const form = new FormData();
form.append("file", selectedFile);
```

Do not manually set `Content-Type` for multipart requests in the browser.

### Cleanup Handling

- Deleting posts removes associated media.
- Deleting tutorials removes associated media where possible.
- Updating profile images attempts to delete the previous image.
- Discussion media cleanup should treat Cloudinary failures as recoverable when metadata consistency can still be preserved.

---

## 8. GitHub Integration

CloudIQ integrates with GitHub for repository access and Codespaces-backed labs.

### OAuth Flow

```text
User clicks Connect GitHub
    |
    v
GET /api/github/login
    |
    v
GitHub OAuth consent
    |
    v
GET /api/github/callback
    |
    v
Store access token in session
    |
    v
Frontend can list repos and launch labs
```

### Repository APIs

```http
GET /api/github/status
GET /api/github/login
GET /api/github/callback
GET /api/github/repos
POST /api/github/logout
```

### Public and Private Repositories

- Public repositories can be checked by URL.
- Private repositories require the authenticated GitHub OAuth token.
- Organization repositories may require SSO/SAML approval.
- GitHub API rate limits and secondary rate limits are surfaced as safe JSON errors.

### Codespaces API

Codespaces labs use repository details and the user GitHub token to create cloud development environments.

Important handling:

- Invalid repo URLs are rejected.
- Missing repository access returns a clean error.
- Organization restrictions return an `ORG_RESTRICTED` style error.
- Codespaces-disabled repos return a frontend-safe error.
- Delete attempts clean backend state even if remote cleanup is already complete or recoverably denied.

---

## 9. Orion AI System

Orion AI powers CloudIQ chat and Brainstorming generation.

### Orion Chat

```http
POST /api/orion/chat
```

Supports:

- Text prompts.
- Optional document text.
- Optional images using the vision model.
- Server-Sent Events streaming.
- Safe JSON errors before streaming starts.
- Stream cleanup when the client disconnects.

### Brainstorming AI

```http
POST /api/brainstorm/ai/generate
POST /api/brainstorm/ai/expand
POST /api/brainstorm/ai/project
```

The optimized generation endpoint returns one idea at a time.

Example request:

```json
{
  "prompt": "Create a cloud app for small business cost tracking",
  "roomId": "optional-room-id",
  "previousIdeas": []
}
```

Example success response:

```json
{
  "success": true,
  "idea": {
    "title": "CloudCost Snapshot",
    "description": "A lightweight dashboard that helps small businesses track cloud spend and spot waste before invoices arrive.",
    "architecture": "React frontend, Express API, Firebase persistence, scheduled cloud billing imports, and Orion summaries.",
    "roadmap": "Start with manual spend entry, add provider imports, then add budget alerts and team reports.",
    "monetization": "Freemium plan for one workspace, paid team plans for alerts, exports, and multi-cloud tracking.",
    "techStack": "React, Node.js, Express, Firebase, Cloud Functions, Cloudinary, Orion AI"
  },
  "ideas": [
    {
      "title": "CloudCost Snapshot",
      "description": "A lightweight dashboard that helps small businesses track cloud spend and spot waste before invoices arrive.",
      "architecture": "React frontend, Express API, Firebase persistence, scheduled cloud billing imports, and Orion summaries.",
      "roadmap": "Start with manual spend entry, add provider imports, then add budget alerts and team reports.",
      "monetization": "Freemium plan for one workspace, paid team plans for alerts, exports, and multi-cloud tracking.",
      "techStack": "React, Node.js, Express, Firebase, Cloud Functions, Cloudinary, Orion AI"
    }
  ],
  "metadata": {
    "model": "moonshotai/kimi-k2-instruct",
    "parseFormat": "json",
    "responseTimeMs": 1200,
    "ideaCursor": 1
  },
  "error": null
}
```

The `ideas` array is kept for compatibility, but new frontend code should prefer `idea`.

### Safety Guarantees

- Prompt validation.
- Provider timeout handling.
- In-flight duplicate request joining.
- Lightweight per-user rate limiting.
- Short retry cache.
- Structured JSON normalization.
- No raw provider stack traces.
- No raw Orion secrets in logs or responses.

---

## 10. Socket.IO

Socket.IO powers realtime updates across CloudIQ.

### Connection and Registration

Clients should register after connecting:

```js
socket.emit("register", {
  sub: user.sub,
  email: user.email,
  username: user.name,
  avatar: user.picture
});
```

The backend stores the latest socket per user and disconnects older duplicate sessions.

### Discussion Events

Client-to-server:

| Event | Purpose |
| --- | --- |
| `join_community_discussions` | Join community discussion namespace/rooms |
| `leave_community_discussions` | Leave community discussion rooms |
| `join_channel` | Join a discussion channel |
| `leave_channel` | Leave a discussion channel |
| `typing_start` | Broadcast typing state |
| `typing_stop` | Stop typing state |
| `new_message` | Send realtime message |
| `message_reaction` | Add/update reaction |

Server-to-client examples:

| Event | Purpose |
| --- | --- |
| `channel_created` | New channel created |
| `channel_deleted` | Channel deleted |
| `new_message` | Message delivered |
| `typing_start` | User typing |
| `typing_stop` | User stopped typing |
| `message_reaction` | Reaction update |
| `unread_count_updates` | Unread state changed |
| `discussion_error` | Explicit discussion socket error |

### Brainstorming Whiteboard Events

Client-to-server:

| Event | Purpose |
| --- | --- |
| `whiteboard:create_room` | Create a brainstorm room |
| `whiteboard:join_room` | Join a whiteboard room |
| `whiteboard:leave_room` | Leave a whiteboard room |
| `whiteboard:sync_canvas` | Sync canvas state |
| `whiteboard:clear_canvas` | Clear canvas |
| `whiteboard:add_sticky_note` | Add a sticky note |
| `whiteboard:add_connector` | Add a connector |

Server-to-client:

| Event | Purpose |
| --- | --- |
| `whiteboard:room_created` | Room created |
| `whiteboard:room_joined` | Room joined with state |
| `whiteboard:user_joined` | Another user joined |
| `whiteboard:user_left` | Another user left |
| `whiteboard:canvas_synced` | Canvas state updated |
| `whiteboard:canvas_cleared` | Canvas cleared |
| `whiteboard:sticky_note_added` | Sticky note created |
| `whiteboard:connector_added` | Connector created |
| `whiteboard_error` | Explicit whiteboard error |

### Realtime Best Practices

- Use REST for history and mutations where possible.
- Use Socket.IO for live delivery and presence.
- Include `mutationId` for whiteboard changes to prevent duplicate local rendering.
- Listen for explicit error events and show inline UI messages.

---

## 11. Deployment Guide

### Production Checklist

- Use Node.js 20 LTS.
- Set `NODE_ENV=production`.
- Set all required environment variables.
- Use HTTPS.
- Configure `FRONTEND_URL` to the exact production frontend origin.
- Configure OAuth callback URLs in IBM App ID and GitHub.
- Use a long random `SESSION_SECRET`.
- Keep Firebase, Cloudinary, GitHub, Cloudant, and Orion secrets out of source control.
- Set `LOG_LEVEL=info`.

### Render

1. Create a new Web Service.
2. Connect the Git repository.
3. Set runtime to Node.
4. Use:

```bash
npm install
```

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

5. Add all environment variables in Render dashboard.
6. Set `NODE_ENV=production`.
7. Set `FRONTEND_URL=https://your-frontend-domain.com`.
8. Update IBM App ID redirect URI:

```text
https://your-backend-domain.onrender.com/auth/callback
```

9. Update GitHub OAuth callback URL:

```text
https://your-backend-domain.onrender.com/api/github/callback
```

### Railway

1. Create a Railway project.
2. Connect the repository.
3. Add environment variables in Railway Variables.
4. Set:

```env
NODE_ENV=production
PORT=5000
```

5. Railway may inject its own `PORT`; the backend already reads `process.env.PORT`.
6. Use start command:

```bash
npm start
```

7. Configure production frontend and OAuth callback URLs to Railway's generated domain.

### VPS

Recommended stack:

- Ubuntu 22.04 or 24.04
- Node.js 20 LTS
- pm2
- Nginx
- Let's Encrypt SSL

Install Node:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Install app:

```bash
git clone <your-repository-url>
cd ibm_backend
npm install --omit=dev
```

Create `.env`:

```bash
nano .env
```

Run with pm2:

```bash
npm install -g pm2
pm2 start server.js --name cloudiq-backend
pm2 save
pm2 startup
```

Nginx reverse proxy:

```nginx
server {
    server_name api.example.com;

    location / {
        proxy_pass <BACKEND_URL>;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable SSL:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com
```

### Docker

Example `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 5000

CMD ["npm", "start"]
```

Build:

```bash
docker build -t cloudiq-backend .
```

Run:

```bash
docker run --env-file .env -p 5000:5000 cloudiq-backend
```

Docker Compose:

```yaml
services:
  cloudiq-backend:
    build: .
    ports:
      - "5000:5000"
    env_file:
      - .env
    restart: unless-stopped
```

---

## 12. Security

### Secret Management

- Never commit `.env`.
- Rotate secrets if they are exposed.
- Use platform secret managers in production.
- Keep Firebase private keys, Cloudinary secrets, GitHub secrets, Cloudant keys, and Orion keys private.
- Use different secrets for development and production.

### Firebase Admin Security

- Use least-privilege service accounts where possible.
- Keep service account JSON out of source control.
- Restrict production Firebase access to trusted backend environments.
- Do not expose Admin SDK credentials to frontend code.

### OAuth Security

- Configure exact redirect URIs.
- Use HTTPS in production.
- Keep GitHub and IBM App ID client secrets private.
- Use secure cookies in production.
- Set `FRONTEND_URL` exactly to the frontend origin.

### Rate Limiting and Request Guards

Current backend protections include:

- Prompt length limits.
- Body size limits.
- Orion timeout handling.
- Brainstorm AI per-user lightweight rate limiting.
- In-flight duplicate AI request joining.
- Short-lived prompt cache.
- Whiteboard mutation deduplication.

For public production deployments, consider adding an external rate limiter such as:

- Cloudflare WAF/rate limiting.
- Render/Railway edge rules.
- Nginx `limit_req`.
- Redis-backed Express rate limiting.

### Validation and Safe Errors

- Malformed JSON returns structured `malformed_json`.
- Oversized body returns `payload_too_large`.
- Provider failures return frontend-safe messages.
- Production stack traces are not exposed by global error handling.

### CORS

The backend only allows the configured frontend origin:

```js
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true
}));
```

Use a single exact production frontend URL, not `*`, when credentials are enabled.

---

## 13. Performance Optimization

### Request Optimization

- Keep `JSON_BODY_LIMIT` and `FORM_BODY_LIMIT` conservative.
- Avoid sending large document text to Orion unless needed.
- Use pagination for messages and feeds.
- Return structured payloads instead of huge markdown blocks.

### Caching

The backend uses in-memory caches for:

- Community membership checks.
- Admin role checks.
- Short-lived AI retry results.
- In-flight AI request joining.

For multi-instance production, move shared rate limiting/cache state to Redis if strict global limits are required.

### Firebase Optimization

- Use indexed Firestore queries.
- Keep message pagination limits small.
- Avoid unbounded realtime listeners.
- Prefer Firestore for metadata and Realtime Database for high-frequency whiteboard state.
- Use `firestore.indexes.json` for required composite indexes.

### Socket.IO Optimization

- Join only the rooms a socket needs.
- Leave rooms on navigation/disconnect.
- Use `mutationId` to avoid duplicate whiteboard renders.
- Avoid broadcasting large payloads at high frequency.
- Throttle canvas sync on the client and server.

### Cloudinary Optimization

- Upload from buffers, not temporary disk paths.
- Use `resource_type: auto` for mixed discussion attachments.
- Use optimized video URLs.
- Delete old media when replacing profile/tutorial/post media.

### Orion Optimization

- Brainstorm generation returns one idea at a time.
- Brainstorm prompt size is capped with `ORION_BRAINSTORM_PROMPT_CHARS`.
- Brainstorm response tokens are capped with `ORION_BRAINSTORM_MAX_TOKENS`.
- The backend normalizes JSON to one frontend-safe idea object.

---

## 14. Troubleshooting

### Firestore gRPC Issues

Symptoms:

- Firestore writes hang or crash.
- `grpc` or `@grpc/grpc-js` errors.
- Windows `EIO`, `EPERM`, or path-related failures.

Fixes:

1. Use Node.js 20 LTS.
2. Stop all running Node processes.
3. Reinstall dependencies:

```bash
Remove-Item -Recurse -Force node_modules
Remove-Item -Force package-lock.json
npm install
```

4. Prefer a short local path on Windows, for example:

```text
C:\cloudiq-backend
```

5. Test Firestore:

```http
GET /api/debug/firestore
```

### Node Version Issues

Use Node 20 LTS for best compatibility with Firebase Admin, Firestore, Socket.IO, and native dependencies.

Check version:

```bash
node -v
```

Recommended:

```text
v20.x.x
```

### Cloudinary Upload Issues

Check:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- File size and MIME type.
- Frontend `FormData` field name.

Discussion uploads must use:

```js
form.append("file", selectedFile);
```

Do not use local file paths in production upload logic.

### GitHub OAuth Issues

Check:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_CALLBACK_URL`
- OAuth callback URL in GitHub Developer Settings.
- Session cookies and frontend origin.

Common callback URL:

```text
<BACKEND_URL>/api/github/callback
```

Production callback:

```text
https://api.example.com/api/github/callback
```

### Codespaces Issues

Common causes:

- User has not connected GitHub.
- Repository is private and token lacks access.
- Organization requires SSO/SAML approval.
- Codespaces disabled for repository or organization.
- GitHub rate limit.
- Existing active lab lock not cleared.

Recommended steps:

1. Reconnect GitHub.
2. Confirm repository access in GitHub UI.
3. Check organization OAuth restrictions.
4. Delete stale lab from CloudIQ.
5. Retry after GitHub rate limits reset.

### Firebase Credential Issues

Symptoms:

- `[FIREBASE] Firebase credentials not configured`
- `Firebase is not configured`
- Firestore routes return empty data or fail.

Fix:

- Ensure all required Firebase variables are present.
- Keep private key newlines escaped as `\n`.
- Wrap private key in quotes in `.env`.
- Restart the backend after changes.

Correct format:

```env
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

### Orion AI Issues

Check:

- `ORION_API_KEY` or `NVIDIA_API_KEY`.
- `ORION_MODEL`.
- `NVIDIA_API_URL`.
- `ORION_API_TIMEOUT_MS`.

If Brainstorming is slow:

- Lower `ORION_BRAINSTORM_MAX_TOKENS`.
- Lower `ORION_BRAINSTORM_PROMPT_CHARS`.
- Keep frontend prompts concise.
- Avoid sending large previous idea arrays.

### CORS and Cookie Issues

Symptoms:

- Login works but frontend still appears logged out.
- Browser blocks requests.
- Cookies missing in production.

Fix:

- Set `FRONTEND_URL` to the exact frontend origin.
- Use HTTPS in production.
- Set `NODE_ENV=production`.
- Ensure frontend sends credentials:

```js
fetch(url, { credentials: "include" });
```

---

## 15. API Documentation

Base URL:

```text
<BACKEND_URL>
```

Production:

```text
https://api.example.com
```

### Health

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/` | No | Health check |
| GET | `/api/debug/firestore` | Debug only | Test Firestore write |

### Authentication

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/auth/login` | No | Start IBM App ID login |
| GET | `/auth/callback` | No | IBM App ID callback |
| GET | `/auth/logout` | Session | Destroy session and redirect |
| GET | `/auth/user` | Optional | Return current user/session state |
| GET | `/auth/status` | Optional | Lightweight auth check |
| GET | `/api/user-role` | Session | Return email and admin role |

Mounted auth route equivalents also exist under:

```text
/api/auth/*
```

### Admin

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/admin/dashboard` | Admin | Admin dashboard data |
| GET | `/api/admin/list` | Admin | List admins |
| POST | `/api/admin/add` | Admin | Add admin |
| PUT | `/api/admin/:id/role` | Admin | Update admin role |
| DELETE | `/api/admin/:id` | Admin | Remove admin |
| GET | `/api/admin/me/role` | Session | Return current admin role |

### User

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/user/profile` | Session | Current user profile |
| GET | `/api/user/dashboard` | Session | Dashboard payload |
| PUT | `/api/user/sync-session` | Session | Sync session to backend user |
| GET | `/api/user/courses` | Session | Courses/labs entry data |
| POST | `/api/user/onboarding` | Session | Complete onboarding with optional image |
| PUT | `/api/user/profile` | Session | Update profile with optional image |
| DELETE | `/api/user/profile-image` | Session | Delete profile image |
| DELETE | `/api/user/account` | Session | Delete user account |

### Communities

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/communities` | Optional/session-aware | List communities |
| GET | `/api/communities/:id` | Optional/session-aware | Get community |
| POST | `/api/communities` | Session | Create community |
| PUT | `/api/communities/:id` | Owner/admin | Update community |
| DELETE | `/api/communities/:id` | Owner/admin | Delete community |
| POST | `/api/communities/:id/join` | Session | Join public community |
| POST | `/api/communities/:id/leave` | Session | Leave community |
| POST | `/api/communities/:id/request` | Session | Request private community access |
| GET | `/api/communities/:id/requests` | Owner/admin | List join requests |
| POST | `/api/communities/:id/requests/:requestId/approve` | Owner/admin | Approve request |
| POST | `/api/communities/:id/requests/:requestId/reject` | Owner/admin | Reject request |

### Discussions

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/discussions/communities/:communityId/channels` | Session | List channels |
| POST | `/api/discussions/communities/:communityId/channels` | Session | Create channel |
| DELETE | `/api/discussions/communities/:communityId/channels/:channelId` | Session | Delete channel |
| GET | `/api/discussions/channels/:channelId/messages` | Session | Paginated messages |
| POST | `/api/discussions/channels/:channelId/messages` | Session | Send text message |
| POST | `/api/discussions/channels/:channelId/media` | Session | Upload media message |
| POST | `/api/discussions/messages/:messageId/pin` | Session | Pin message |
| POST | `/api/discussions/messages/:messageId/unpin` | Session | Unpin message |
| POST | `/api/discussions/messages/:messageId/reactions` | Session | Add/update reaction |
| POST | `/api/discussions/channels/:channelId/read` | Session | Mark channel read |
| GET | `/api/discussions/communities/:communityId/unreads` | Session | Get unread counts |

### Brainstorming

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/brainstorm/rooms` | Session | Create room |
| GET | `/api/brainstorm/rooms/:roomId` | Session | Get room and whiteboard |
| POST | `/api/brainstorm/rooms/:roomId/join` | Session | Join room |
| POST | `/api/brainstorm/rooms/:roomId/leave` | Session | Leave room |
| POST | `/api/brainstorm/rooms/:roomId/sync` | Session | Sync whiteboard |
| POST | `/api/brainstorm/rooms/:roomId/clear` | Session | Clear whiteboard |
| POST | `/api/brainstorm/rooms/:roomId/notes` | Session | Add sticky note |
| POST | `/api/brainstorm/rooms/:roomId/connectors` | Session | Add connector |
| DELETE | `/api/brainstorm/rooms/:roomId` | Owner/admin | Delete room |
| POST | `/api/brainstorm/ai/generate` | Session | Generate one structured idea |
| POST | `/api/brainstorm/ai/expand` | Session | Expand one idea |
| POST | `/api/brainstorm/ai/project` | Session | Convert idea to project concept |

### Orion AI

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/orion/chat` | Session | Streaming Orion chat |

### Labs

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/labs` | Session | List user labs |
| POST | `/api/labs/create` | Session + GitHub | Create Codespaces lab |
| DELETE | `/api/labs/:labId` | Session | Delete one lab |
| DELETE | `/api/labs` | Session | Delete active/current lab |

### GitHub

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/github/status` | Session | GitHub connection status |
| GET | `/api/github/login` | Session | Start GitHub OAuth |
| GET | `/api/github/callback` | GitHub OAuth | GitHub callback |
| GET | `/api/github/repos` | Session + GitHub | List repositories |
| POST | `/api/github/logout` | Session | Disconnect GitHub |

### Uploads and Media

| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/posts/create` | Session | Create post with optional images/videos |
| POST | `/api/tutorials` | Session/admin depending route logic | Create tutorial with media |
| POST | `/api/tutorials/...` | Session/admin depending route logic | Inline tutorial media upload routes |
| POST | `/api/discussions/channels/:channelId/media` | Session | Discussion media upload |
| POST | `/api/user/onboarding` | Session | Profile image during onboarding |
| PUT | `/api/user/profile` | Session | Profile image update |
| POST | `/api/voice/transcribe` | Session | Audio transcription via IBM Watson |

### Posts, Comments, Friends, Notifications

| Area | Endpoints |
| --- | --- |
| Posts | `GET /api/posts`, `POST /api/posts/create`, `DELETE /api/posts/:id`, `POST /api/posts/:id/like` |
| Comments | `POST /api/comments/create`, `GET /api/comments/:post_id`, `DELETE /api/comments/:id` |
| Friends | `GET /api/friends/discover`, `POST /api/friends/request`, `POST /api/friends/accept`, `POST /api/friends/reject`, `DELETE /api/friends/:id`, `GET /api/friends` |
| Notifications | `GET /api/notifications`, `PATCH /api/notifications/:id/read` |
| Tutorials | `GET /api/tutorials`, `GET /api/tutorials/:id`, `POST /api/tutorials`, `PUT /api/tutorials/:id`, `DELETE /api/tutorials/:id` plus inline media routes |

---

## 16. Contributing Guide

### Branch Workflow

Use short, descriptive branches:

```bash
git checkout -b fix/orion-brainstorm-response
git checkout -b feature/lab-session-cleanup
git checkout -b docs/backend-readme
```

### Local Development Workflow

1. Pull latest changes.
2. Install dependencies if `package.json` changed.
3. Create a focused branch.
4. Make a small, behavior-preserving change.
5. Run targeted checks.
6. Open a pull request.

### Recommended Checks

For touched backend files:

```bash
node --check server.js
node --check routes/brainstorm.js
node --check routes/orion.js
node --check services/brainstormService.js
node --check services/firebaseService.js
node --check sockets/discussions.js
node --check sockets/whiteboard.js
```

Run the server:

```bash
npm run dev
```

### Commit Standards

Use clear, action-oriented commit messages:

```text
fix: stabilize Orion brainstorming responses
feat: add Codespaces lab cleanup
docs: expand backend deployment guide
chore: tighten production logging
```

### Pull Request Checklist

- The change is scoped and easy to review.
- Auth, discussions, tutorials, labs, Firebase, Socket.IO, and Orion integrations are not broken.
- New environment variables are documented.
- Error responses are frontend-safe.
- Secrets are not logged or committed.
- Syntax checks pass for touched files.
- Deployment notes are updated when needed.

---

## Production Notes

CloudIQ Backend is designed to be practical, stable, and deployment-ready. Keep changes incremental, preserve existing contracts, and document every new external dependency or environment variable.

Recommended production defaults:

```env
NODE_ENV=production
LOG_LEVEL=info
ORION_API_TIMEOUT_MS=60000
ORION_BRAINSTORM_PROMPT_CHARS=1800
ORION_BRAINSTORM_MAX_TOKENS=900
```

Use Node 20 LTS, keep secrets in your hosting provider's environment manager, and verify Firebase, Cloudinary, GitHub OAuth, Cloudant, and Orion credentials before shipping.

