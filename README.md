# CloudIQ Backend

CloudIQ Backend is the Express, Socket.IO, IBM App ID, Cloudant, Firebase, Cloudinary, NVIDIA Orion, and GitHub Codespaces API layer for the CloudIQ learning platform.

It owns authentication, user sessions, communities, realtime discussions, uploads, tutorials, posts, friends, notifications, collaborative brainstorming, AI generation, voice transcription, GitHub OAuth, and temporary Codespaces lab sessions.

## Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Repository Structure](#repository-structure)
- [Local Setup](#local-setup)
- [Environment Variables](#environment-variables)
- [Authentication](#authentication)
- [Data Stores](#data-stores)
- [Media Uploads](#media-uploads)
- [GitHub Codespaces Labs](#github-codespaces-labs)
- [Orion AI](#orion-ai)
- [Socket.IO](#socketio)
- [API Reference](#api-reference)
- [Frontend Integration Notes](#frontend-integration-notes)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Security Notes](#security-notes)

## Overview

The backend exposes REST APIs for normal request/response workflows and Socket.IO events for realtime collaboration.

Primary responsibilities:

| Area | Responsibility |
| --- | --- |
| Auth | IBM App ID login, callback, logout, session checks, role/admin checks |
| Users | Profile, dashboard, onboarding, courses, account deletion |
| Communities | Create, update, join, leave, membership requests, approvals, owner/admin access |
| Discussions | Channels, messages, uploads, reactions, read state, pinning, realtime delivery |
| Posts | Feed posts, media uploads, likes, deletion |
| Tutorials | Tutorial creation, media handling, listing, updates, deletion |
| Friends | Discovery, requests, accept/reject, removal, list |
| Notifications | User notifications and read state |
| Brainstorming | Rooms, whiteboard state, notes, connectors, AI-generated ideas |
| Labs | GitHub OAuth, repo listing, Codespaces creation/deletion, active-lab lock handling |
| AI | Orion/NVIDIA NIM chat and brainstorming generation |
| Voice | IBM Watson Speech to Text transcription |
| Observability | Health check, startup route summary, env-driven logs, Firestore debug route |

## Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js, Express |
| Realtime | Socket.IO |
| Auth | IBM App ID, Passport, express-session |
| Primary document store | IBM Cloudant |
| Realtime/discussion/lab metadata | Firebase Admin SDK, Firestore, Firebase Realtime Database |
| Media | Cloudinary, multer memory storage |
| AI | NVIDIA NIM-compatible Orion calls |
| Labs | GitHub OAuth, GitHub REST API, Codespaces API |
| Voice | IBM Watson Speech to Text |
| Logging | `utils/logger.js` with `debug`, `info`, `warn`, `error` levels |

## Architecture

```text
CloudIQ Frontend
      |
      | HTTPS REST, session cookies, Socket.IO
      v
CloudIQ Backend
      |
      |-- Express routes
      |-- Passport sessions
      |-- Socket.IO handlers
      |-- Service modules
      |
      +--> IBM App ID
      +--> IBM Cloudant
      +--> Firebase Admin / Firestore / RTDB
      +--> Cloudinary
      +--> GitHub OAuth + Codespaces API
      +--> NVIDIA NIM / Orion
      +--> IBM Watson STT
```

Request lifecycle:

```text
Client request
  -> helmet
  -> CORS
  -> JSON/form body parsing
  -> session
  -> Passport
  -> route-level auth guard
  -> route handler
  -> service integration
  -> frontend-safe JSON response
```

Socket lifecycle:

```text
Client connects
  -> register user socket
  -> optional discussion/whiteboard room joins
  -> authorization check
  -> realtime events
  -> presence/typing/read-state cleanup on disconnect
```

## Repository Structure

```text
cloudiq-backend/
|-- server.js                         # Express app, HTTP server, Socket.IO, route mounts
|-- package.json                      # Runtime scripts and dependencies
|-- .env.example                      # Environment variable template
|-- DISCUSSION_PANEL_README.md        # Frontend discussion/media handoff contract
|-- firestore.indexes.json            # Firestore indexes for deployment
|-- config/
|   |-- appid.js                      # IBM App ID config helpers
|   |-- env.js                        # URL/CORS/env validation helpers
|   `-- session.js                    # Session config helper
|-- middleware/
|   |-- auth.js                       # Session auth, user identity, admin helpers
|   |-- authMiddleware.js             # Additional auth middleware
|   `-- githubAuth.js                 # GitHub OAuth guards/session helpers
|-- routes/
|   |-- admin.js                      # Admin dashboard/admin management
|   |-- auth.js                       # IBM App ID auth routes
|   |-- brainstorm.js                 # Brainstorm rooms and AI endpoints
|   |-- comments.js                   # Post comments
|   |-- community.js                  # Communities and membership workflows
|   |-- discussions.js                # Discussion REST API and media uploads
|   |-- friends.js                    # Friend discovery and requests
|   |-- githubAuth.js                 # GitHub OAuth, status, repos, logout
|   |-- labs.js                       # Codespaces lab lifecycle
|   |-- notifications.js              # Notifications
|   |-- orion.js                      # Orion/NVIDIA chat API
|   |-- posts.js                      # Feed posts and media
|   |-- tutorials.js                  # Tutorials and tutorial media
|   |-- user.js                       # User profile/dashboard/onboarding
|   `-- voice.js                      # Watson speech transcription
|-- services/
|   |-- adminDb.js                    # Admin persistence helpers
|   |-- brainstormService.js          # Brainstorm room/AI service logic
|   |-- cacheService.js               # Cache helpers
|   |-- cloudantClient.js             # Cloudant client, DB setup, design docs
|   |-- cloudinaryService.js          # Buffer-only Cloudinary uploads/deletes
|   |-- firebaseService.js            # Firebase Admin, Firestore, RTDB helpers
|   |-- githubCodespacesService.js    # GitHub repo/Codespaces/token helpers
|   |-- labCleanupService.js          # Scheduled lab expiration cleanup
|   |-- mediaService.js               # Media helpers
|   |-- notificationService.js        # Notification helpers
|   `-- statsService.js               # Stats helpers
|-- sockets/
|   |-- discussions.js                # Discussion Socket.IO events
|   `-- whiteboard.js                 # Brainstorm whiteboard Socket.IO events
|-- utils/
|   |-- db.js                         # User/admin DB helpers
|   `-- logger.js                     # Env-driven logging and redaction
`-- data/
    `-- users.json                    # Local/user data fallback file
```

## Local Setup

### Prerequisites

- Node.js 20 LTS recommended.
- npm.
- IBM Cloudant credentials.
- IBM App ID application.
- Firebase project with a service account.
- Cloudinary account.
- NVIDIA API key for Orion/NIM calls.
- GitHub OAuth app for Labs.
- Optional: IBM Watson Speech to Text credentials.

### Install

```bash
npm install
```

### Configure

Create a local `.env` from `.env.example`:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Fill in real values in `.env`. Do not commit `.env` or real credentials.

### Run

```bash
npm run dev
```

Production-style start:

```bash
npm start
```

Default port:

```text
http://localhost:5000
```

Health check:

```text
GET /api/health
```

## Environment Variables

### Server

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | Yes | `development` or `production` |
| `PORT` | Yes | Defaults to `5000` if unset |
| `LOG_LEVEL` | Recommended | `debug`, `info`, `warn`, or `error`; production default is `info` |
| `FRONTEND_URL` | Production | First frontend origin, for redirects and CORS |
| `BACKEND_URL` | Production | Public backend origin, used for OAuth callback construction |
| `CORS_ALLOWED_ORIGINS` | Production | Comma-separated extra origins |
| `SESSION_SECRET` | Yes | Strong secret for express-session |
| `JSON_BODY_LIMIT` | Optional | Defaults to `1mb` |
| `FORM_BODY_LIMIT` | Optional | Defaults to `1mb` |

### IBM App ID

| Variable | Required | Notes |
| --- | --- | --- |
| `APPID_TENANT_ID` | Yes | IBM App ID tenant ID |
| `APPID_CLIENT_ID` | Yes | App ID client ID |
| `APPID_SECRET` | Yes | App ID secret |
| `APPID_OAUTH_SERVER_URL` | Yes | App ID OAuth server URL |
| `APPID_REDIRECT_URI` | Yes | Must exactly match the App ID dashboard callback |
| `APPID_DISCOVERY_ENDPOINT` | Optional | Discovery endpoint |
| `APPID_PROFILES_URL` | Optional | Profiles base URL |
| `APPID_MANAGEMENT_URL` | Optional | Management API URL |
| `APPID_API_KEY` | Optional | Management API key |
| `ADMIN_ROLE_ID` | Optional | App ID role ID |
| `ADMIN_ROLE_NAME` | Optional | Defaults to `admin` |
| `ADMIN_EMAILS` | Optional | Comma-separated super-admin emails |

Expected backend callback:

```text
{BACKEND_URL}/api/auth/callback
```

### Cloudant

| Variable | Required | Notes |
| --- | --- | --- |
| `CLOUDANT_APIKEY` | Yes | IBM Cloudant IAM API key |
| `CLOUDANT_URL` | Yes | Cloudant service URL |

The Cloudant service initializes required databases and design documents on startup.

### Firebase

| Variable | Required | Notes |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | Yes | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Yes | Service account client email |
| `FIREBASE_PRIVATE_KEY` | Yes | Private key with escaped newlines |
| `FIREBASE_DATABASE_URL` | Recommended | RTDB URL |
| `VITE_FIREBASE_DATABASE_URL` | Backward compatible | Used only as fallback by backend |
| `FIRESTORE_DEBUG_ROUTE_ENABLED` | Optional | Set `true` to allow `/api/debug/firestore` in production |

Use this format for private keys:

```env
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

### Cloudinary

| Variable | Required | Notes |
| --- | --- | --- |
| `CLOUDINARY_CLOUD_NAME` | Yes | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Yes | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Yes | Cloudinary API secret |

### GitHub OAuth and Codespaces

| Variable | Required | Notes |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth app secret |
| `GITHUB_CALLBACK_URL` | Recommended | Defaults to `{BACKEND_URL}/api/github/callback` |
| `GITHUB_API_VERSION` | Optional | Defaults to `2026-03-10` |
| `LAB_TTL_MINUTES` | Optional | Defaults to `30` |
| `LAB_TOKEN_ENCRYPTION_KEY` | Production | Used for encrypted lab token/session support |

Expected GitHub callback:

```text
{BACKEND_URL}/api/github/callback
```

GitHub OAuth scopes:

```text
codespace repo read:user
```

### Orion / NVIDIA NIM

| Variable | Required | Notes |
| --- | --- | --- |
| `ORION_API_KEY` | Yes | Preferred NVIDIA/NIM key variable |
| `NVIDIA_API_KEY` | Fallback | Used if `ORION_API_KEY` is missing |
| `NVIDIA_NIM_API_KEY` | Fallback | Used if both above are missing |
| `NVIDIA_API_URL` | Optional | Defaults to NVIDIA chat completions endpoint |
| `ORION_MODEL` | Recommended | Default `moonshotai/kimi-k2-instruct` |
| `ORION_VISION_MODEL` | Optional | Default `meta/llama-3.2-11b-vision-instruct` |
| `ORION_API_TIMEOUT_MS` | Optional | Default `60000` |
| `ORION_MAX_QUERY_CHARS` | Optional | Chat input guard |
| `ORION_MAX_DOCUMENT_CHARS` | Optional | Document input guard |
| `ORION_MAX_IMAGES` | Optional | Image count guard |
| `ORION_BRAINSTORM_PROMPT_CHARS` | Optional | Default `1800` |
| `ORION_BRAINSTORM_MAX_TOKENS` | Optional | Default `900` |

### IBM Watson STT

| Variable | Required | Notes |
| --- | --- | --- |
| `WATSON_STT_API_KEY` | For voice route | Watson Speech to Text API key |
| `WATSON_STT_URL` | For voice route | Watson Speech to Text service URL |

### Safe `.env` Skeleton

```env
NODE_ENV=development
PORT=5000
LOG_LEVEL=debug
FRONTEND_URL=http://localhost:5173
BACKEND_URL=http://localhost:5000
CORS_ALLOWED_ORIGINS=http://localhost:5173
SESSION_SECRET=replace-with-a-strong-local-secret

CLOUDANT_APIKEY=replace-me
CLOUDANT_URL=https://replace-me.cloudantnosqldb.appdomain.cloud

APPID_TENANT_ID=replace-me
APPID_CLIENT_ID=replace-me
APPID_SECRET=replace-me
APPID_OAUTH_SERVER_URL=https://region.appid.cloud.ibm.com/oauth/v4/tenant-id
APPID_REDIRECT_URI=http://localhost:5000/api/auth/callback
ADMIN_ROLE_NAME=admin
ADMIN_EMAILS=admin@example.com

FIREBASE_PROJECT_ID=replace-me
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@example.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nreplace-me\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://project-id-default-rtdb.firebaseio.com

CLOUDINARY_CLOUD_NAME=replace-me
CLOUDINARY_API_KEY=replace-me
CLOUDINARY_API_SECRET=replace-me

GITHUB_CLIENT_ID=replace-me
GITHUB_CLIENT_SECRET=replace-me
GITHUB_CALLBACK_URL=http://localhost:5000/api/github/callback
GITHUB_API_VERSION=2026-03-10
LAB_TTL_MINUTES=30
LAB_TOKEN_ENCRYPTION_KEY=replace-with-a-long-random-secret

ORION_API_KEY=replace-me
ORION_MODEL=moonshotai/kimi-k2-instruct
ORION_API_TIMEOUT_MS=60000

WATSON_STT_API_KEY=replace-me
WATSON_STT_URL=replace-me
```

## Authentication

The backend uses IBM App ID for user login and Passport sessions for browser authentication.

Core auth routes:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/login` | Start IBM App ID login |
| `GET` | `/api/auth/callback` | Handle IBM App ID callback |
| `GET` | `/api/auth/logout` | Destroy session and redirect |
| `GET` | `/api/auth/user` | Return current user/session state |
| `GET` | `/api/auth/status` | Lightweight login status |
| `GET` | `/api/auth/debug-user` | Debug current session user |
| `GET` | `/api/user-role` | Return email/admin role state |
| `POST` | `/api/add-admin` | Add admin email/role access |
| `DELETE` | `/api/remove-admin` | Remove admin access |
| `GET` | `/api/list-admins` | List admins |

Important identity rule:

```text
userId = user.sub
```

Use the IBM App ID `sub` value as the canonical user identity for ownership, membership, discussion authorization, socket registration, and lab ownership. Do not replace it with email, username, or GitHub ID.

## Data Stores

### Cloudant

Cloudant stores platform documents such as users, posts, comments, notifications, communities, community requests, memberships, friendships, admins, tutorials, tutorial media, and upload metadata.

`services/cloudantClient.js` initializes the Cloudant client and ensures required databases/design documents exist.

### Firebase Firestore

Firestore is used for discussion and lab metadata paths that need realtime-friendly persistence:

- Discussion channels.
- Discussion messages.
- Presence, typing, read state, reactions, and pinned metadata.
- Brainstorm room metadata and AI generations.
- Lab records and lab sessions.

### Firebase Realtime Database

RTDB is retained for collaborative whiteboard state and older compatibility paths.

### Firestore Debug Route

```text
GET /api/debug/firestore
```

In production this route is blocked unless:

```env
FIRESTORE_DEBUG_ROUTE_ENABLED=true
```

Use it to verify Firebase Admin credentials and Firestore write behavior before debugging higher-level routes.

## Media Uploads

All file uploads should use in-memory buffers. The backend intentionally uses `multer.memoryStorage()` and streams buffers directly into Cloudinary.

Do not depend on local disk uploads for runtime behavior.

Supported media areas:

| Area | Route |
| --- | --- |
| User onboarding image | `POST /api/user/onboarding` |
| User profile image | `PUT /api/user/profile` |
| Post images/videos | `POST /api/posts/create` |
| Tutorial media | `POST /api/tutorials`, tutorial inline media routes |
| Discussion files | `POST /api/discussions/channels/:channelId/media` |

Discussion media flow:

```text
Frontend FormData
  -> multer memory storage
  -> Cloudinary upload_stream
  -> Firestore message metadata
  -> REST response
  -> Socket.IO/new history render path
```

Frontend upload rule:

```js
const form = new FormData();
form.append('file', selectedFile);
```

Let the browser set the multipart boundary. Do not manually set `Content-Type` for `FormData`.

## GitHub Codespaces Labs

Labs allow an authenticated CloudIQ user to connect GitHub, launch one active Codespace-backed lab, open the returned Codespace URL, and delete the active lab when done.

Main routes:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/github/status` | Check GitHub connection |
| `GET` | `/api/github/login` | Start GitHub OAuth |
| `GET` | `/api/github/callback` | GitHub OAuth callback |
| `GET` | `/api/github/repos` | List accessible repositories |
| `POST` | `/api/github/logout` | Disconnect GitHub session |
| `GET` | `/api/labs` | List labs and current active lab |
| `POST` | `/api/labs/create` | Create a Codespaces lab |
| `DELETE` | `/api/labs/:labId` | Delete a specific lab |
| `DELETE` | `/api/labs` | Delete the active lab |

Create lab body:

```json
{
  "repoUrl": "https://github.com/owner/repo",
  "branch": "main",
  "labName": "my-api-lab"
}
```

Create lab response includes:

```json
{
  "success": true,
  "data": {
    "labId": "uuid",
    "display_name": "cloudiq-my-api-lab",
    "repoUrl": "https://github.com/owner/repo",
    "codespaceName": "codespace-name",
    "webUrl": "https://...",
    "status": "active",
    "active": true,
    "expiresAt": "iso-date"
  },
  "webUrl": "https://...",
  "expiresAt": "iso-date"
}
```

Lifecycle guarantees:

- Only one active lab is allowed per user.
- Expired active labs are released before creating a new lab.
- Deleting a lab clears active state so the user can create another lab immediately.
- GitHub cleanup failures are handled as recoverable when possible.
- The cleanup service runs on a schedule to expire/delete stale lab sessions.

## Orion AI

Orion uses NVIDIA NIM-compatible chat completion requests.

Routes:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/orion/chat` | Authenticated streaming/chat response |
| `POST` | `/api/brainstorm/ai/generate` | Generate one structured idea |
| `POST` | `/api/brainstorm/ai/expand` | Expand an idea |
| `POST` | `/api/brainstorm/ai/project` | Convert idea to project concept |

Recommended model:

```env
ORION_MODEL=moonshotai/kimi-k2-instruct
```

The model ID should include the publisher prefix.

## Socket.IO

Socket.IO is mounted on the same HTTP server as Express.

### Base Registration

Client registers after connecting:

```js
socket.emit('register', {
  userId: user.sub,
  email: user.email,
  username: user.name,
  picture: user.picture
});
```

Server may emit:

| Event | Purpose |
| --- | --- |
| `socket_error` | Invalid socket registration or generic socket error |
| `duplicate_session` | Another socket registered for the same user |

### Discussion Events

Client events:

| Event | Payload |
| --- | --- |
| `join_community_discussions` | `{ community_id }` |
| `leave_community_discussions` | `{ community_id }` |
| `join_channel` | `{ channel_id }` |
| `leave_channel` | `{ channel_id }` |
| `typing_start` | `{ channel_id }` |
| `typing_stop` | `{ channel_id }` |
| `new_message` | `{ channel_id, content, text, client_temp_id }` |
| `message_reaction` | `{ message_id, emoji }` |

Server events:

| Event | Purpose |
| --- | --- |
| `discussion_error` | Frontend-safe discussion/socket error |
| `channel_joined` | Channel join confirmation |
| `new_message` | New persisted message |
| `message_reaction` | Reaction update |
| `join_leave_updates` | Community presence updates |
| `unread_count_updates` | Channel unread refresh hint |

### Whiteboard Events

Client events:

| Event | Purpose |
| --- | --- |
| `whiteboard:create_room` | Create collaborative room |
| `whiteboard:join_room` | Join room |
| `whiteboard:leave_room` | Leave room |
| `whiteboard:sync_canvas` | Persist/broadcast canvas state |
| `whiteboard:clear_canvas` | Clear canvas |
| `whiteboard:add_sticky_note` | Add note |
| `whiteboard:add_connector` | Add connector |

Server events:

| Event | Purpose |
| --- | --- |
| `whiteboard_error` | Frontend-safe error |
| `whiteboard:room_created` | Created room |
| `whiteboard:room_joined` | Joined room plus current state |
| `whiteboard:canvas_cleared` | Canvas cleared broadcast |
| `whiteboard:sticky_note_added` | Note broadcast |
| `whiteboard:connector_added` | Connector broadcast |

## API Reference

### Health and Debug

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Public | Server health |
| `GET` | `/api/debug/firestore` | Dev or enabled prod | Test Firestore write |

### Users

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/user/profile` | Session | Current profile |
| `GET` | `/api/user/dashboard` | Session | Dashboard data |
| `PUT` | `/api/user/sync-session` | Session | Sync session/user data |
| `GET` | `/api/user/courses` | Session | Courses data |
| `POST` | `/api/user/onboarding` | Session | Save onboarding/profile image |
| `PUT` | `/api/user/profile` | Session | Update profile/profile image |
| `DELETE` | `/api/user/profile-image` | Session | Delete profile image |
| `DELETE` | `/api/user/account` | Session | Delete account |

### Admin

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/admin/dashboard` | Admin | Admin dashboard |
| `GET` | `/api/admin/list` | Admin | List admin users |
| `POST` | `/api/admin/add` | Admin | Add admin |
| `PUT` | `/api/admin/:id/role` | Admin | Update role |
| `DELETE` | `/api/admin/:id` | Admin | Delete admin/user entry |
| `GET` | `/api/admin/me/role` | Session | Current user role |

### Communities

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/communities` | Public | List communities |
| `GET` | `/api/communities/:id` | Public/session-aware | Get community |
| `POST` | `/api/communities` | Session | Create community |
| `PUT` | `/api/communities/:id` | Owner/admin | Update community |
| `DELETE` | `/api/communities/:id` | Owner/admin | Delete community |
| `POST` | `/api/communities/:id/join` | Session | Join public community |
| `POST` | `/api/communities/:id/leave` | Session | Leave community |
| `POST` | `/api/communities/:id/request` | Session | Request private community access |
| `GET` | `/api/communities/:id/requests` | Owner/admin | List membership requests |
| `POST` | `/api/communities/:id/requests/:requestId/approve` | Owner/admin | Approve request |
| `POST` | `/api/communities/:id/requests/:requestId/reject` | Owner/admin | Reject request |

### Discussions

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/discussions/communities/:communityId/channels` | Member | List channels |
| `POST` | `/api/discussions/communities/:communityId/channels` | Member/admin logic | Create channel |
| `DELETE` | `/api/discussions/communities/:communityId/channels/:channelId` | Owner/admin | Delete channel |
| `GET` | `/api/discussions/channels/:channelId/messages` | Channel member | Message history |
| `POST` | `/api/discussions/channels/:channelId/messages` | Channel member | Create text message |
| `POST` | `/api/discussions/channels/:channelId/media` | Channel member | Upload media message |
| `POST` | `/api/discussions/messages/:messageId/pin` | Member/admin logic | Pin message |
| `POST` | `/api/discussions/messages/:messageId/unpin` | Member/admin logic | Unpin message |
| `POST` | `/api/discussions/messages/:messageId/reactions` | Member | Add/update reaction |
| `POST` | `/api/discussions/channels/:channelId/read` | Member | Mark channel read |
| `GET` | `/api/discussions/communities/:communityId/unreads` | Member | Unread state |

### Posts, Comments, Friends, Notifications

| Area | Routes |
| --- | --- |
| Posts | `GET /api/posts`, `POST /api/posts/create`, `DELETE /api/posts/:id`, `POST /api/posts/:id/like` |
| Comments | `POST /api/comments/create`, `GET /api/comments/:post_id`, `DELETE /api/comments/:id` |
| Friends | `GET /api/friends/discover`, `POST /api/friends/request`, `POST /api/friends/accept`, `POST /api/friends/reject`, `DELETE /api/friends/:id`, `GET /api/friends` |
| Notifications | `GET /api/notifications`, `PATCH /api/notifications/:id/read` |

### Tutorials

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/tutorials` | Public | List tutorials |
| `GET` | `/api/tutorials/:id` | Public | Get tutorial |
| `POST` | `/api/tutorials` | Session/admin logic | Create tutorial |
| `PUT` | `/api/tutorials/:id` | Session/admin logic | Update tutorial |
| `DELETE` | `/api/tutorials/:id` | Session/admin logic | Delete tutorial |

The tutorials route also contains inline media upload endpoints for tutorial content assets.

### Brainstorm

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/brainstorm/rooms` | Session-aware route logic | Create room |
| `GET` | `/api/brainstorm/rooms/:roomId` | Session-aware route logic | Get room |
| `POST` | `/api/brainstorm/rooms/:roomId/join` | Session-aware route logic | Join room |
| `POST` | `/api/brainstorm/rooms/:roomId/leave` | Session-aware route logic | Leave room |
| `POST` | `/api/brainstorm/rooms/:roomId/sync` | Session-aware route logic | Sync whiteboard |
| `POST` | `/api/brainstorm/rooms/:roomId/clear` | Session-aware route logic | Clear whiteboard |
| `POST` | `/api/brainstorm/rooms/:roomId/notes` | Session-aware route logic | Add note |
| `POST` | `/api/brainstorm/rooms/:roomId/connectors` | Session-aware route logic | Add connector |
| `DELETE` | `/api/brainstorm/rooms/:roomId` | Session-aware route logic | Delete room |
| `POST` | `/api/brainstorm/ai/generate` | Session-aware route logic | Generate idea |
| `POST` | `/api/brainstorm/ai/expand` | Session-aware route logic | Expand idea |
| `POST` | `/api/brainstorm/ai/project` | Session-aware route logic | Convert to project |

### Voice

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/voice/transcribe` | Session | Transcribe uploaded audio |

## Frontend Integration Notes

### Sessions and Cookies

Frontend requests should include credentials:

```js
fetch(`${backendUrl}/api/auth/user`, {
  credentials: 'include'
});
```

Axios:

```js
axios.create({
  baseURL: backendUrl,
  withCredentials: true
});
```

### Discussion Panel

Use REST for history and mutations. Use Socket.IO for realtime delivery.

Recommended order:

1. Fetch `/api/auth/user`.
2. Use `user.sub` as `userId`.
3. Fetch channels with `/api/discussions/communities/:communityId/channels`.
4. Fetch messages with `/api/discussions/channels/:channelId/messages`.
5. Connect Socket.IO and emit `register`.
6. Join community/channel sockets after REST authorization succeeds.
7. Upload files through `/api/discussions/channels/:channelId/media`.
8. Render the returned media message immediately and also accept the realtime message event.

See [DISCUSSION_PANEL_README.md](./DISCUSSION_PANEL_README.md) for the full frontend handoff.

### Labs Page

Frontend should expose:

- GitHub connection state.
- GitHub login redirect.
- Repository URL input.
- Optional branch/ref input.
- Optional custom lab name input.
- Launch button.
- Active lab status.
- Countdown from `expiresAt`.
- Open Codespace link from `webUrl`.
- Delete lab button.
- Inline error states for `GITHUB_AUTH_REQUIRED`, `PRIVATE_REPO_AUTH_REQUIRED`, `DUPLICATE_ACTIVE_LAB`, `REPO_NOT_FOUND`, `ORG_RESTRICTED`, and `CODESPACES_UNAVAILABLE`.

## Operations

### Startup Behavior

On startup the backend:

- Loads `.env`.
- Validates production environment variables.
- Configures CORS and sessions.
- Initializes Passport and IBM App ID when configured.
- Mounts GitHub OAuth and labs routes.
- Initializes Cloudant and design documents.
- Initializes Firebase Admin when configured.
- Configures Cloudinary.
- Starts Socket.IO.
- Starts scheduled lab cleanup.
- Logs mounted route groups and callback URL hints.

### Logging

Use:

```env
LOG_LEVEL=info
```

Available levels:

```text
debug < info < warn < error
```

`utils/logger.js` redacts sensitive keys and token-like values before logging.

Recommended production defaults:

```env
NODE_ENV=production
LOG_LEVEL=info
ORION_API_TIMEOUT_MS=60000
ORION_BRAINSTORM_PROMPT_CHARS=1800
ORION_BRAINSTORM_MAX_TOKENS=900
```

### Checks

Syntax-check touched files:

```bash
node --check server.js
node --check routes/discussions.js
node --check routes/labs.js
node --check routes/orion.js
node --check services/firebaseService.js
node --check services/githubCodespacesService.js
node --check sockets/discussions.js
node --check sockets/whiteboard.js
```

Run the server:

```bash
npm run dev
```

Build is not defined for this backend. Use syntax checks and live route smoke tests.

## Troubleshooting

### Server exits immediately in production

`config/env.js` exits in production when required variables are missing or URLs are invalid.

Check:

- `FRONTEND_URL`
- `BACKEND_URL`
- `SESSION_SECRET`
- Cloudant credentials
- Firebase credentials
- Cloudinary credentials
- GitHub credentials
- IBM App ID credentials
- `ORION_API_KEY`

### CORS or cookies fail

Confirm:

- `FRONTEND_URL` exactly matches the browser origin.
- `CORS_ALLOWED_ORIGINS` includes every deployed frontend origin.
- Frontend requests use credentials.
- Production URLs are HTTPS.
- Callback URLs have no accidental trailing slash unless the provider dashboard also has it.

### IBM App ID callback fails

Confirm the dashboard callback exactly matches:

```text
{BACKEND_URL}/api/auth/callback
```

Also check:

- `APPID_REDIRECT_URI`
- `APPID_OAUTH_SERVER_URL`
- `APPID_CLIENT_ID`
- `APPID_SECRET`
- Browser cookies are accepted.

### GitHub OAuth callback fails

Confirm the GitHub OAuth app callback exactly matches:

```text
{BACKEND_URL}/api/github/callback
```

Check:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_CALLBACK_URL`
- User is already authenticated with CloudIQ before starting GitHub OAuth.

### Codespace creation fails

Common response codes:

| Code | Meaning |
| --- | --- |
| `GITHUB_AUTH_REQUIRED` | User must connect GitHub |
| `PRIVATE_REPO_AUTH_REQUIRED` | Private/restricted repo needs GitHub auth |
| `DUPLICATE_ACTIVE_LAB` | User already has one active lab |
| `REPO_NOT_FOUND` | Repo URL is wrong or inaccessible |
| `ORG_RESTRICTED` | Organization SSO/OAuth approval required |
| `GITHUB_RATE_LIMIT` | GitHub API rate limit |
| `CODESPACES_UNAVAILABLE` | Codespaces unavailable for repo/account |
| `FIRESTORE_PERSISTENCE_FAILED` | Codespace was created but lab metadata could not persist |

### Firestore/gRPC issues on Windows

Recommended runtime:

```text
Node.js 20 LTS
```

Useful checks:

- Move the backend to a shorter path if native module or deep-path issues appear.
- Verify `/api/debug/firestore` in development.
- Confirm the private key has escaped newlines.
- Confirm Firestore indexes are deployed when querying ordered/filter paths.

### Discussion media uploads fail

Confirm:

- Frontend uses `FormData.append('file', file)`.
- Frontend does not manually set multipart `Content-Type`.
- Cloudinary variables are configured.
- Firebase variables are configured.
- The user is authorized for the channel.
- The route is `/api/discussions/channels/:channelId/media`.

### Orion returns provider errors

Confirm:

- `ORION_API_KEY` is valid.
- `ORION_MODEL` includes the publisher prefix.
- `NVIDIA_API_URL` points to the expected chat completions endpoint.
- Request size does not exceed configured guards.

## Security Notes

- Never commit real `.env` values.
- Rotate any credential that was committed or shared.
- Use strong `SESSION_SECRET` and `LAB_TOKEN_ENCRYPTION_KEY` values in production.
- Keep `NODE_ENV=production` for deployed environments.
- Use HTTPS origins in production.
- Keep provider callback URLs exact.
- Avoid logging request bodies that contain credentials, tokens, private keys, or cookies.
- Keep uploads buffer-only and validate authorization before accepting media.
- Preserve the canonical identity rule: `userId = user.sub`.
- Keep REST and Socket.IO authorization aligned for discussions and communities.

## Deployment Notes

For Render, Railway, Fly.io, Azure, IBM Cloud, or a VPS:

1. Set all required environment variables in the hosting provider's secret manager.
2. Use Node.js 20 LTS.
3. Install dependencies with `npm install`.
4. Start with `npm start`.
5. Configure IBM App ID callback to `{BACKEND_URL}/api/auth/callback`.
6. Configure GitHub OAuth callback to `{BACKEND_URL}/api/github/callback`.
7. Configure frontend `VITE_BACKEND_URL` or equivalent to the backend public URL.
8. Ensure frontend requests include cookies/credentials.
9. Verify `/api/health`.
10. Verify auth login/logout.
11. Verify `/api/debug/firestore` only in development or with explicit production enablement.
12. Verify Cloudinary upload, discussion history, GitHub OAuth, lab creation/deletion, and Orion chat.

This backend should be changed incrementally. Auth, discussions, Firestore, Cloudinary, Codespaces labs, Socket.IO, tutorials, posts, communities, and Orion all share session and identity assumptions, so update contracts carefully and keep frontend-facing behavior stable.
