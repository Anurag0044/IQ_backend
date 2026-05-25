# CloudIQ Backend

Production-ready Express.js API for the CloudIQ learning platform, with IBM App ID authentication, IBM Cloudant data storage, Firebase-powered realtime discussions, Cloudinary uploads, AI features, and GitHub Codespaces labs.

## Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Folder Structure](#folder-structure)
- [API Base URL](#api-base-url)
- [Installation](#installation)
- [Environment Variables](#environment-variables)
- [How To Run](#how-to-run)
- [Authentication Flow](#authentication-flow)
- [API Documentation](#api-documentation)
- [Request And Response Examples](#request-and-response-examples)
- [Socket.IO Usage](#socketio-usage)
- [How To Test APIs](#how-to-test-apis)
- [Deployment Guide](#deployment-guide)
- [Security Practices](#security-practices)
- [Troubleshooting](#troubleshooting)
- [Contribution Guide](#contribution-guide)
- [License](#license)
- [Contact](#contact)

## Overview

CloudIQ Backend is the API and realtime server for the CloudIQ learning platform. It handles login sessions, user profiles, communities, social posts, comments, friend connections, notifications, tutorials, realtime discussion channels, collaborative brainstorming rooms, AI assistance, voice transcription, and temporary GitHub Codespaces lab sessions.

The backend exposes:

- REST APIs for normal request and response workflows.
- Socket.IO events for realtime notifications, discussions, post comments, presence, typing, and whiteboard collaboration.
- Secure session-based authentication through IBM App ID and Passport.js.
- Cloudant, Firebase, and Cloudinary integrations for persistent content, realtime metadata, and media storage.

## Features

- IBM App ID OAuth login, callback, logout, and session checks.
- Role-based admin system with `main_admin`, `co_admin`, `elder_admin`, and `junior_admin` roles.
- User onboarding, profile image upload, dashboard stats, and account deletion.
- Community creation, update, delete, join, leave, and restricted-community join requests.
- Social posts with image/video uploads, likes, comments, and realtime comment broadcasts.
- Friend discovery, friend requests, accept/reject flow, and live friend notifications.
- User notification feed with read state.
- Tutorial CRUD with cover media and inline media upload support.
- Firestore-backed discussion channels, messages, reactions, pinned messages, unread counts, typing, and presence.
- Collaborative brainstorm rooms and whiteboard sync.
- Orion AI chat and brainstorming helpers through NVIDIA NIM-compatible APIs.
- IBM Watson Speech to Text voice transcription.
- GitHub OAuth, repository listing, and GitHub Codespaces lab lifecycle management.
- Socket.IO stats, trending updates, user registration, discussion events, and whiteboard events.
- Centralized logging with sensitive key redaction.

## Tech Stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js |
| Web framework | Express.js |
| Realtime | Socket.IO |
| Authentication | IBM App ID, Passport.js, `express-session` |
| Session storage | Express session cookie (`connect.sid`) |
| JWT | No custom JWT layer is implemented. IBM App ID tokens are handled by Passport and stored server-side in the session. |
| Primary database | IBM Cloudant |
| Realtime/discussion/lab metadata | Firebase Admin SDK, Firestore, Firebase Realtime Database |
| Media storage | Cloudinary |
| File uploads | Multer memory storage |
| AI | NVIDIA NIM-compatible API, Orion routes |
| Voice | IBM Watson Speech to Text |
| GitHub labs | GitHub OAuth, GitHub REST API, Codespaces API |
| Security middleware | Helmet, CORS, secure session cookies |
| Logging | Morgan and `utils/logger.js` |
| Scheduling | `node-cron` for lab cleanup |

## Folder Structure

```text
cloudiq-backend/
|-- config/
|   |-- appid.js              # Optional IBM App ID Passport configuration helper
|   |-- env.js                # Environment URL, CORS, and production validation helpers
|   `-- session.js            # Express session configuration helper
|-- data/
|   `-- users.json            # Local legacy/sample user data
|-- middleware/
|   |-- auth.js               # Main auth, admin, and user identity middleware
|   |-- authMiddleware.js     # Backward-compatible auth middleware re-export
|   `-- githubAuth.js         # GitHub OAuth helper middleware
|-- routes/
|   |-- admin.js              # Admin dashboard and admin role management
|   |-- auth.js               # IBM App ID auth routes mounted at /api/auth
|   |-- brainstorm.js         # Brainstorm rooms, whiteboard state, and AI actions
|   |-- comments.js           # Post comments and replies
|   |-- community.js          # Communities, memberships, and join requests
|   |-- discussions.js        # Firestore discussion channels, messages, reactions, media
|   |-- friends.js            # Friend discovery and friend request flow
|   |-- githubAuth.js         # GitHub OAuth and repository listing
|   |-- labs.js               # GitHub Codespaces lab sessions
|   |-- notifications.js      # Notification feed and read status
|   |-- orion.js              # Orion AI chat endpoint
|   |-- posts.js              # Feed posts, media, likes, and deletion
|   |-- tutorials.js          # Tutorial CRUD and tutorial media uploads
|   |-- user.js               # User profile, onboarding, dashboard, account routes
|   `-- voice.js              # IBM Watson voice transcription
|-- services/
|   |-- adminDb.js            # Cloudant-backed admin role service
|   |-- brainstormService.js  # Brainstorm room, whiteboard, and AI business logic
|   |-- cacheService.js       # In-memory TTL caches
|   |-- cloudantClient.js     # Cloudant client, databases, and design documents
|   |-- cloudinaryService.js  # Cloudinary upload/delete helpers
|   |-- firebaseService.js    # Firestore, RTDB, discussions, and labs persistence
|   |-- githubCodespacesService.js # GitHub repo and Codespaces API helpers
|   |-- labCleanupService.js  # Expired lab cleanup service
|   |-- mediaService.js       # Media upload metadata helpers
|   |-- notificationService.js # Notification creation and realtime delivery
|   `-- statsService.js       # Realtime stats/trending Socket.IO broadcaster
|-- sockets/
|   |-- discussions.js        # Discussion Socket.IO handlers
|   `-- whiteboard.js         # Brainstorm whiteboard Socket.IO handlers
|-- utils/
|   |-- db.js                 # Legacy user/admin helper utilities
|   `-- logger.js             # Structured logger with sensitive key redaction
|-- server.js                 # Main Express app, Socket.IO setup, middleware, and route mounts
|-- package.json              # Scripts and dependencies
|-- firestore.indexes.json    # Firestore index definitions
|-- test_cloudant.js          # Cloudant connection test helper
`-- test_create.js            # Cloudant document creation test helper
```

## API Base URL

```text
Local:      http://localhost:5000
Production: https://your-backend-domain.com
```

All `/api/*` routes below are relative to the base URL.

## Installation

1. Clone the repository.

```bash
git clone https://github.com/your-org/cloudiq-backend.git
cd cloudiq-backend
```

2. Install dependencies.

```bash
npm install
```

3. Create a `.env` file.

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

4. Fill the `.env` values described in the next section.

5. Run the development server.

```bash
npm run dev
```

## Environment Variables

Never commit real API keys, private keys, OAuth secrets, or service credentials. Use the following safe template for local setup.

```env
# Server
PORT=5000
NODE_ENV=development
LOG_LEVEL=debug
JSON_BODY_LIMIT=1mb
FORM_BODY_LIMIT=1mb

# URLs and CORS
FRONTEND_URL=http://localhost:5173
BACKEND_URL=http://localhost:5000
CORS_ALLOWED_ORIGINS=http://localhost:5173

# Session
SESSION_SECRET=replace-with-a-long-random-session-secret

# IBM Cloudant
CLOUDANT_APIKEY=replace-with-cloudant-iam-api-key
CLOUDANT_URL=https://your-cloudant-instance.cloudantnosqldb.appdomain.cloud

# IBM App ID
APPID_TENANT_ID=replace-with-app-id-tenant-id
APPID_CLIENT_ID=replace-with-app-id-client-id
APPID_SECRET=replace-with-app-id-client-secret
APPID_OAUTH_SERVER_URL=https://region.appid.cloud.ibm.com/oauth/v4/tenant-id
APPID_REDIRECT_URI=http://localhost:5000/api/auth/callback
APPID_DISCOVERY_ENDPOINT=https://region.appid.cloud.ibm.com/oauth/v4/tenant-id/.well-known/openid-configuration
APPID_PROFILES_URL=https://region.appid.cloud.ibm.com
APPID_MANAGEMENT_URL=https://region.appid.cloud.ibm.com/management/v4/tenant-id
APPID_API_KEY=replace-with-app-id-management-api-key

# Admin roles
ADMIN_EMAILS=admin@example.com
ADMIN_ROLE_ID=replace-with-app-id-admin-role-id
ADMIN_ROLE_NAME=admin

# Firebase Admin
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-user@your-firebase-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nreplace-with-private-key\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://your-firebase-project-id-default-rtdb.firebaseio.com

# Cloudinary
CLOUDINARY_CLOUD_NAME=your-cloudinary-cloud-name
CLOUDINARY_API_KEY=replace-with-cloudinary-api-key
CLOUDINARY_API_SECRET=replace-with-cloudinary-api-secret

# GitHub OAuth and Codespaces Labs
GITHUB_CLIENT_ID=replace-with-github-oauth-client-id
GITHUB_CLIENT_SECRET=replace-with-github-oauth-client-secret
GITHUB_CALLBACK_URL=http://localhost:5000/api/github/callback
GITHUB_API_VERSION=2026-03-10
LAB_TTL_MINUTES=30
LAB_TOKEN_ENCRYPTION_KEY=replace-with-32-byte-or-longer-random-secret

# Orion AI / NVIDIA NIM
NVIDIA_API_URL=https://integrate.api.nvidia.com/v1/chat/completions
ORION_API_KEY=replace-with-api-key
ORION_MODEL=moonshotai/kimi-k2-instruct
ORION_VISION_MODEL=meta/llama-3.2-11b-vision-instruct
ORION_API_TIMEOUT_MS=60000
ORION_MAX_QUERY_CHARS=12000
ORION_MAX_DOCUMENT_CHARS=60000
ORION_MAX_IMAGES=4
ORION_BRAINSTORM_PROMPT_CHARS=1800
ORION_BRAINSTORM_MAX_TOKENS=900

# IBM Watson Speech to Text
WATSON_STT_API_KEY=replace-with-watson-stt-api-key
WATSON_STT_URL=https://api.region.speech-to-text.watson.cloud.ibm.com/instances/instance-id

# Debug flags
FIRESTORE_DEBUG_ROUTE_ENABLED=false
```

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | Yes | Port used by Express. Defaults to `5000`. |
| `NODE_ENV` | Yes | Use `development` locally and `production` in deployment. |
| `LOG_LEVEL` | No | Logger level: `debug`, `info`, `warn`, or `error`. |
| `JSON_BODY_LIMIT` | No | Maximum JSON request body size. Defaults to `1mb`. |
| `FORM_BODY_LIMIT` | No | Maximum URL-encoded form body size. Defaults to `1mb`. |
| `FRONTEND_URL` | Yes | Frontend origin. Also used for OAuth redirects and CORS. |
| `BACKEND_URL` | Yes | Public backend origin. Used to build callback URLs. |
| `CORS_ALLOWED_ORIGINS` | No | Extra comma-separated allowed origins. |
| `SESSION_SECRET` | Yes | Secret used to sign Express session cookies. Use a long random value. |
| `CLOUDANT_APIKEY` | Yes | IBM Cloudant IAM API key. |
| `CLOUDANT_URL` | Yes | IBM Cloudant service URL. |
| `APPID_TENANT_ID` | Yes | IBM App ID tenant ID. |
| `APPID_CLIENT_ID` | Yes | IBM App ID application client ID. |
| `APPID_SECRET` | Yes | IBM App ID application secret. |
| `APPID_OAUTH_SERVER_URL` | Yes | IBM App ID OAuth server URL. |
| `APPID_REDIRECT_URI` | Yes | Must exactly match the App ID dashboard callback URL. Use `/api/auth/callback`. |
| `APPID_DISCOVERY_ENDPOINT` | Optional | App ID OpenID discovery endpoint. |
| `APPID_PROFILES_URL` | Optional | App ID profiles service base URL. |
| `APPID_MANAGEMENT_URL` | Optional | App ID management API URL. |
| `APPID_API_KEY` | Optional | App ID management API key. |
| `ADMIN_EMAILS` | Recommended | Comma-separated super admin emails. These users become `main_admin`. |
| `ADMIN_ROLE_ID` | Optional | App ID admin role ID if roles are configured in IBM App ID. |
| `ADMIN_ROLE_NAME` | Optional | App ID admin role name. Defaults to `admin` in debug role checks. |
| `FIREBASE_PROJECT_ID` | Yes | Firebase project ID for Firestore and Realtime Database. |
| `FIREBASE_CLIENT_EMAIL` | Yes | Firebase service account client email. |
| `FIREBASE_PRIVATE_KEY` | Yes | Firebase service account private key. Keep escaped newlines as `\n`. |
| `FIREBASE_DATABASE_URL` | Yes | Firebase Realtime Database URL. |
| `CLOUDINARY_CLOUD_NAME` | Yes | Cloudinary cloud name. |
| `CLOUDINARY_API_KEY` | Yes | Cloudinary API key. |
| `CLOUDINARY_API_SECRET` | Yes | Cloudinary API secret. |
| `GITHUB_CLIENT_ID` | Yes for labs | GitHub OAuth app client ID. |
| `GITHUB_CLIENT_SECRET` | Yes for labs | GitHub OAuth app client secret. |
| `GITHUB_CALLBACK_URL` | Recommended | GitHub OAuth callback URL. Use `/api/github/callback`. |
| `GITHUB_API_VERSION` | No | GitHub API version header. Defaults to `2026-03-10`. |
| `LAB_TTL_MINUTES` | No | Minutes before a lab is treated as expired. Defaults to `30`. |
| `LAB_TOKEN_ENCRYPTION_KEY` | Yes for labs | Secret used by GitHub lab helpers. Use a long random value. |
| `NVIDIA_API_URL` | No | NVIDIA chat completions URL. |
| `ORION_API_KEY` | Yes for AI | API key for Orion/NVIDIA AI calls. |
| `NVIDIA_API_KEY` / `NVIDIA_NIM_API_KEY` | Optional | Alternate variable names accepted by the code. |
| `ORION_MODEL` | No | Default text model. |
| `ORION_VISION_MODEL` | No | Vision model used when image data is sent. |
| `ORION_API_TIMEOUT_MS` | No | AI provider timeout in milliseconds. |
| `ORION_MAX_QUERY_CHARS` | No | Maximum user query length for `/api/orion/chat`. |
| `ORION_MAX_DOCUMENT_CHARS` | No | Maximum attached document text length. |
| `ORION_MAX_IMAGES` | No | Maximum image attachments for Orion chat. |
| `ORION_BRAINSTORM_PROMPT_CHARS` | No | Maximum prompt length for brainstorm AI actions. |
| `ORION_BRAINSTORM_MAX_TOKENS` | No | Maximum generated tokens for brainstorm AI actions. |
| `WATSON_STT_API_KEY` | Yes for voice | IBM Watson Speech to Text API key. |
| `WATSON_STT_URL` | Yes for voice | IBM Watson Speech to Text service URL. |
| `FIRESTORE_DEBUG_ROUTE_ENABLED` | No | Enables `/api/debug/firestore` in production when set to `true`. |

## How To Run

Development mode with auto-restart:

```bash
npm run dev
```

Production mode:

```bash
npm start
```

Expected startup logs include route mounts, Cloudant initialization, Firebase status, Cloudinary status, App ID status, and Socket.IO readiness.

This project does not define a build script. Deploy it as a Node.js service and start it with `npm start`.

## Authentication Flow

This backend uses IBM App ID OAuth with Passport.js sessions. It does not implement a custom JWT login endpoint.

1. The frontend sends the user to `GET /api/auth/login`.
2. The backend redirects the user to the IBM App ID hosted login page.
3. IBM App ID redirects back to `GET /api/auth/callback`.
4. Passport validates the App ID response and stores the user object in the server-side session.
5. Express sends a secure HTTP-only session cookie named `connect.sid`.
6. The backend checks whether the user is an admin using `ADMIN_EMAILS` and the Cloudant `admins` database.
7. The user is redirected to the frontend `/admin` page if they are an admin, otherwise to `/dashboard`.
8. Protected routes call `ensureAuthenticated`, which checks `req.isAuthenticated()`.
9. Admin routes additionally call `ensureAdmin`.

Important cookie behavior:

- In production, cookies are sent with `secure: true` and `sameSite: "none"` so HTTPS is required.
- In development, cookies use `sameSite: "lax"` and can work over local HTTP.
- API clients must preserve cookies after login. In Postman, enable the cookie jar. In browsers, use `credentials: "include"`.

## API Documentation

Authentication values in the table:

- `Public`: no login required.
- `Session`: requires a valid App ID/Passport session cookie.
- `Admin`: requires a session and admin privileges.
- `Owner/Moderator/Admin`: requires resource ownership, community moderator access, or admin privileges.
- `Dev`: only available outside production unless explicitly enabled.

### Health And Debug

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/` | Public | None | `{ "success": true, "message": "CloudIQ backend running" }` | Root health check. |
| `GET` | `/api/health` | Public | None | `{ "success": true, "status": "healthy" }` | API health check. |
| `GET` | `/api/debug/firestore` | Dev | None | `{ "success": true, "message": "Firestore debug write succeeded", "doc": {} }` | Writes a Firestore debug document. Hidden in production unless `FIRESTORE_DEBUG_ROUTE_ENABLED=true`. |

### Auth

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/auth/login` | Public | None | Redirects to IBM App ID | Starts IBM App ID login. |
| `GET` | `/api/auth/callback` | Public | None | Redirects to frontend `/admin` or `/dashboard` | OAuth callback handled by Passport. |
| `GET` | `/api/auth/logout` | Public | None | Redirects to frontend root | Clears App ID tokens, Passport session, and cookies. |
| `GET` | `/api/auth/user` | Public | None | `{ "loggedIn": true, "success": true, "user": {} }` | Returns current session user or `{ "loggedIn": false }`. |
| `GET` | `/api/auth/status` | Public | None | `{ "authenticated": true, "isAdmin": false }` | Lightweight auth status check. |
| `GET` | `/api/auth/debug-user` | Dev | None | `{ "loggedIn": true, "rawUser": {} }` | Debugs raw App ID user data outside production. |

Legacy auth aliases also exist: `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/user`, `/auth/status`, and `/debug-user`.

### Legacy Role/Admin Helpers

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/user-role` | Session | None | `{ "success": true, "email": "user@example.com", "isAdmin": true, "adminRole": "main_admin" }` | Returns current user's admin status. |
| `POST` | `/api/add-admin` | Super admin | `{ "newAdminEmail": "admin@example.com" }` | `{ "success": true, "message": "admin@example.com added as junior_admin" }` | Legacy super-admin route for adding an admin. |
| `DELETE` | `/api/remove-admin` | Super admin | `{ "adminEmail": "admin@example.com" }` | `{ "success": true, "message": "admin@example.com removed from admins" }` | Legacy super-admin route for removing an admin. |
| `GET` | `/api/list-admins` | Super admin | None | `{ "success": true, "admins": [] }` | Legacy super-admin route for listing admins. |

### Admin

All `/api/admin/*` routes require `Session + Admin`.

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/admin/dashboard` | Admin | None | `{ "success": true, "data": { "totalUsers": 0, "totalPosts": 0, "systemHealth": "operational", "myRole": "main_admin" } }` | Admin dashboard counts and health. |
| `GET` | `/api/admin/list` | Admin | None | `{ "success": true, "admins": [] }` | Lists all main and Cloudant-backed admins. |
| `POST` | `/api/admin/add` | `main_admin` or `co_admin` | `{ "email": "admin@example.com", "role": "junior_admin" }` | `{ "success": true, "message": "admin@example.com added as junior_admin" }` | Adds a Cloudant admin. |
| `PUT` | `/api/admin/:id/role` | Admin hierarchy | `{ "role": "elder_admin" }` | `{ "success": true, "message": "admin@example.com role updated to elder_admin" }` | Updates an admin role. `:id` is the target admin email. |
| `DELETE` | `/api/admin/:id` | Admin hierarchy | None | `{ "success": true, "message": "admin@example.com removed from admins" }` | Removes a Cloudant admin. |
| `GET` | `/api/admin/me/role` | Admin | None | `{ "success": true, "role": "co_admin", "email": "admin@example.com" }` | Returns the calling admin's role. |

Valid assignable admin roles are `co_admin`, `elder_admin`, and `junior_admin`. `main_admin` comes from `ADMIN_EMAILS`.

### User

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/user/profile` | Session | None | `{ "success": true, "is_onboarded": true, "data": {} }` | Gets the current user's profile. |
| `GET` | `/api/user/dashboard` | Session | None | `{ "success": true, "data": { "timeSpent": 0, "points": 0, "tutorialsCount": 0, "activities": [] } }` | Gets dashboard learning stats. |
| `PUT` | `/api/user/sync-session` | Session | `{ "timeAdded": 15, "pointsAdded": 10, "activity": { "title": "Completed tutorial" } }` | `{ "success": true, "data": { "timeSpent": 15, "points": 10 } }` | Adds elapsed learning time, points, and optional activity. |
| `GET` | `/api/user/courses` | Session | None | `{ "success": true, "data": { "enrolled": [], "recommended": [], "completed": [] } }` | Legacy courses stub. |
| `POST` | `/api/user/onboarding` | Session | `multipart/form-data`: `username`, `purpose`, `referral_source`, `professional_role`, optional `profile_image` | `{ "success": true, "data": {} }` | Creates first-time user profile and uploads image to Cloudinary. |
| `PUT` | `/api/user/profile` | Session | `multipart/form-data`: optional `username`, `professional_role`, `profile_image` | `{ "success": true, "data": {} }` | Updates user profile and optional image. |
| `DELETE` | `/api/user/profile-image` | Session | None | `{ "success": true, "data": {} }` | Deletes Cloudinary profile image and clears profile image fields. |
| `DELETE` | `/api/user/account` | Session | None | `{ "success": true, "message": "Account permanently deleted." }` | Deletes profile, profile image, and session. |

### GitHub OAuth

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/github/status` | Session | None | `{ "success": true, "connected": true, "github": {} }` | Checks whether GitHub is connected in the current session. |
| `GET` | `/api/github/login` | Session | None | Redirects to GitHub | Starts GitHub OAuth for labs. |
| `GET` | `/api/github/callback` | Public OAuth callback | None | Redirects to frontend `/labs?github=connected` | Stores GitHub OAuth data in session. |
| `GET` | `/api/github/repos?page=1&per_page=30` | Session + GitHub | None | `{ "success": true, "repos": [] }` | Lists repositories for the connected GitHub account. |
| `POST` | `/api/github/logout` | Session | None | `{ "success": true, "message": "GitHub disconnected." }` | Removes GitHub data from session. |

### Labs

All lab routes require an App ID session. Creating a lab also requires a connected GitHub session.

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/labs` | Session | None | `{ "success": true, "data": [], "activeLab": null, "githubConnected": true }` | Lists current user's lab sessions. |
| `POST` | `/api/labs/create` | Session + GitHub | `{ "repoUrl": "https://github.com/owner/repo", "labName": "my-lab", "branch": "main" }` | `{ "success": true, "data": {}, "webUrl": "https://...", "labId": "uuid" }` | Creates one GitHub Codespace-backed lab. |
| `DELETE` | `/api/labs/:labId` | Session | None | `{ "success": true, "message": "Lab deleted.", "data": {} }` | Deletes a specific lab and cleans up Codespace data. |
| `DELETE` | `/api/labs` | Session | None | `{ "success": true, "message": "Lab deleted.", "data": {} }` | Deletes the current active lab. |

### Posts

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/posts?limit=25&before=2026-05-25T00:00:00.000Z` | Public | None | `{ "success": true, "posts": [], "nextBefore": null }` | Lists posts newest first with optional pagination. |
| `POST` | `/api/posts/create` | Session | `multipart/form-data`: `content`, optional `community_id`, optional `image`, `video`, or `media` | `{ "success": true, "post": {} }` | Creates a post and uploads optional media. |
| `DELETE` | `/api/posts/:id` | Owner/Moderator/Admin | None | `{ "success": true, "message": "Post deleted" }` | Deletes a post and associated Cloudinary media. |
| `POST` | `/api/posts/:id/like` | Session | None | `{ "success": true, "liked": true, "likesCount": 1 }` | Toggles the current user's like on a post. |

### Comments

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/comments/create` | Session | `{ "post_id": "post-id", "content": "Nice post!", "parent_id": "optional-parent-comment-id" }` | `{ "success": true, "comment": {} }` | Creates a root comment or reply. |
| `GET` | `/api/comments/:post_id` | Public | None | `{ "success": true, "comments": [] }` | Lists comments for a post with nested replies. |
| `DELETE` | `/api/comments/:id` | Owner/Moderator/Admin | None | `{ "success": true, "message": "Comment deleted" }` | Deletes a comment. |

### Communities

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/communities?limit=25&before=...` | Public | None | `{ "success": true, "communities": [] }` | Lists public community records. |
| `GET` | `/api/communities?mine=true` | Session | None | `{ "success": true, "communities": [] }` | Lists communities joined by the current user. |
| `GET` | `/api/communities/:id` | Public | None | `{ "success": true, "community": {} }` | Gets one community. |
| `POST` | `/api/communities` | Session | `multipart/form-data`: `name`, `description`, optional `category`, `color`, `visibility`, `logo`, `banner` | `{ "success": true, "community": {} }` | Creates a community and default discussion channel. |
| `PUT` | `/api/communities/:id` | Owner/Moderator/Admin | `multipart/form-data`: optional `name`, `description`, `category`, `color`, `visibility`, `co_admin_ids`, `logo`, `banner` | `{ "success": true, "community": {} }` | Updates a community. |
| `DELETE` | `/api/communities/:id` | Owner/Moderator/Admin | None | `{ "success": true, "message": "Community deleted" }` | Deletes a community and media. |
| `POST` | `/api/communities/:id/join` | Session | None | `{ "success": true, "community": {} }` or `{ "success": true, "pending": true, "request": {} }` | Joins public communities or creates a pending request for restricted communities. |
| `POST` | `/api/communities/:id/leave` | Session | None | `{ "success": true, "community": {} }` | Leaves a community. Owners cannot leave their own community. |
| `POST` | `/api/communities/:id/request` | Session | None | `{ "success": true, "pending": true, "request": {} }` | Creates a join request for a restricted community. |
| `GET` | `/api/communities/:id/requests` | Owner/Moderator/Admin | None | `{ "success": true, "requests": [] }` | Lists pending join requests. |
| `POST` | `/api/communities/:id/requests/:requestId/approve` | Owner/Moderator/Admin | None | `{ "success": true, "community": {}, "request": {} }` | Approves a join request. |
| `POST` | `/api/communities/:id/requests/:requestId/reject` | Owner/Moderator/Admin | None | `{ "success": true, "request": {} }` | Rejects a join request. |

### Friends

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/friends/discover?limit=50` | Session | None | `{ "success": true, "users": [] }` | Lists onboarded users with friendship status. |
| `POST` | `/api/friends/request` | Session | `{ "receiver_id": "user-id" }` | `{ "success": true, "friendship": {} }` | Sends a friend request. |
| `POST` | `/api/friends/accept` | Session | `{ "request_id": "friendship-id" }` | `{ "success": true, "friendship": {} }` | Accepts a received request. |
| `POST` | `/api/friends/reject` | Session | `{ "request_id": "friendship-id" }` | `{ "success": true, "message": "Request rejected/withdrawn" }` | Rejects or withdraws a request. |
| `DELETE` | `/api/friends/:id` | Session | None | `{ "success": true, "message": "Connection removed" }` | Removes a friend connection. |
| `GET` | `/api/friends` | Session | None | `{ "success": true, "friends": [], "pendingSent": [], "pendingReceived": [], "all": [] }` | Lists accepted and pending friendships. |

### Notifications

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/notifications?limit=25` | Session | None | `{ "success": true, "notifications": [] }` | Lists current user's notifications. |
| `PATCH` | `/api/notifications/:id/read` | Session | None | `{ "success": true, "notification": {} }` | Marks one notification as read. |

### Tutorials

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/tutorials` | Public | None | `{ "success": true, "total": 0, "data": [] }` | Lists tutorials newest first. |
| `GET` | `/api/tutorials/:id` | Public | None | `{ "success": true, "data": {} }` | Gets one tutorial. |
| `POST` | `/api/tutorials/create` | Session, with content rules | `multipart/form-data`: `title`, `description`, `content` or `content_markdown`, optional `category`, `tags`, `community_id`, `image`, `video` | `{ "success": true, "message": "Tutorial created successfully", "data": {} }` | Creates a tutorial. Admins can create global tutorials. Community members can create community tutorials, with limits for non-moderators. |
| `PUT` | `/api/tutorials/:id` | Owner/Moderator/Admin | `multipart/form-data`: optional `title`, `description`, `content`, `content_markdown`, `category`, `tags`, `community_id`, `image`, `video` | `{ "success": true, "data": {} }` | Updates a tutorial. |
| `DELETE` | `/api/tutorials/:id` | Owner/Moderator/Admin | None | `{ "success": true, "message": "Tutorial deleted successfully" }` | Deletes a tutorial and cover media. |
| `POST` | `/api/tutorials/upload-inline-image` | Session | `multipart/form-data`: `image`, optional `tutorial_id` | `{ "success": true, "url": "https://...", "public_id": "...", "resource_type": "image" }` | Uploads inline tutorial image or video using the `image` field. |
| `POST` | `/api/tutorials/upload-inline-media` | Session | `multipart/form-data`: `media`, optional `tutorial_id` | `{ "success": true, "url": "https://...", "public_id": "...", "resource_type": "video" }` | Uploads inline tutorial image or video using the `media` field. |
| `DELETE` | `/api/tutorials/image` | Session | `{ "public_id": "cloudinary-public-id", "resource_type": "image" }` | `{ "success": true, "message": "Image deleted successfully" }` | Deletes inline tutorial media from Cloudinary. |

### Discussions

All discussion routes require a session and community access. Data is stored in Firestore. Community membership is checked against Cloudant.

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/discussions/communities/:communityId/channels` | Session + member/admin | None | `{ "success": true, "channels": [] }` | Lists discussion channels for a community. Creates a default `general` channel if none exists. |
| `POST` | `/api/discussions/communities/:communityId/channels` | Moderator/Admin | `{ "name": "general", "topic": "Announcements", "type": "text", "visibility": "members", "allowed_member_ids": [] }` | `{ "success": true, "channel": {} }` | Creates a discussion channel. |
| `DELETE` | `/api/discussions/communities/:communityId/channels/:channelId` | Moderator/Admin | None | `{ "success": true, "message": "Channel deleted" }` | Deletes a discussion channel. |
| `GET` | `/api/discussions/channels/:channelId/messages?limit=30&before=...` | Session + channel access | None | `{ "success": true, "messages": [] }` | Lists paginated channel messages. |
| `POST` | `/api/discussions/channels/:channelId/messages` | Session + channel access | `{ "content": "Hello team" }` | `{ "success": true, "message": {} }` | Sends a text message. |
| `POST` | `/api/discussions/channels/:channelId/media` | Session + channel access | `multipart/form-data`: `file` | `{ "success": true, "message": {} }` | Uploads chat media or attachment and creates a message. |
| `POST` | `/api/discussions/messages/:messageId/pin` | Moderator/Admin | None | `{ "success": true }` | Pins a message. |
| `POST` | `/api/discussions/messages/:messageId/unpin` | Moderator/Admin | None | `{ "success": true }` | Unpins a message. |
| `POST` | `/api/discussions/messages/:messageId/reactions` | Session + channel access | `{ "emoji": "thumbs_up", "action": "add" }` | `{ "success": true, "persisted": true }` | Adds or removes a reaction. Use `"action": "remove"` to remove. |
| `POST` | `/api/discussions/channels/:channelId/read` | Session + channel access | None | `{ "success": true }` | Marks a channel as read for the current user. |
| `GET` | `/api/discussions/communities/:communityId/unreads` | Session + member/admin | None | `{ "success": true, "unreads": [] }` | Lists unread counts for the current user. |

### Brainstorm

All brainstorm routes require a session.

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/brainstorm/rooms` | Session | `{ "communityId": "community-id", "title": "New idea room" }` | `{ "success": true, "room": {} }` | Creates a brainstorm room. |
| `GET` | `/api/brainstorm/rooms/:roomId` | Session + room access | None | `{ "success": true, "room": {}, "whiteboard": {} }` | Loads a room and whiteboard state. |
| `POST` | `/api/brainstorm/rooms/:roomId/join` | Session + room access | None | `{ "success": true, "room": {} }` | Joins a brainstorm room. |
| `POST` | `/api/brainstorm/rooms/:roomId/leave` | Session + room access | None | `{ "success": true }` | Leaves a brainstorm room. |
| `POST` | `/api/brainstorm/rooms/:roomId/sync` | Session + room access | `{ "whiteboard": { "nodes": [], "edges": [] } }` | `{ "success": true, "whiteboard": {} }` | Saves whiteboard state. |
| `POST` | `/api/brainstorm/rooms/:roomId/clear` | Session + room access | None | `{ "success": true, "whiteboard": {} }` | Clears whiteboard state. |
| `POST` | `/api/brainstorm/rooms/:roomId/notes` | Session + room access | `{ "note": { "text": "Idea", "x": 100, "y": 100 } }` | `{ "success": true, "note": {} }` | Adds a sticky note. |
| `POST` | `/api/brainstorm/rooms/:roomId/connectors` | Session + room access | `{ "connector": { "from": "note-a", "to": "note-b" } }` | `{ "success": true, "connector": {} }` | Adds a connector. |
| `DELETE` | `/api/brainstorm/rooms/:roomId` | Session + owner/moderator | None | `{ "success": true }` | Deletes a brainstorm room. |
| `POST` | `/api/brainstorm/ai/generate` | Session | `{ "prompt": "Ideas for cloud security project", "roomId": "optional", "previousIdeas": [] }` | `{ "success": true, "idea": {}, "ideas": [{}], "metadata": {} }` | Generates a new idea. |
| `POST` | `/api/brainstorm/ai/expand` | Session | `{ "prompt": "Expand this idea", "previousIdeas": [] }` | `{ "success": true, "idea": {}, "ideas": [{}] }` | Expands an idea. |
| `POST` | `/api/brainstorm/ai/project` | Session | `{ "prompt": "Turn this into a project plan" }` | `{ "success": true, "idea": {}, "ideas": [{}] }` | Converts an idea into a project-style output. |

### Orion AI

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/orion/chat` | Session | `{ "query": "Explain Kubernetes", "documentText": "optional text", "images": ["data:image/png;base64,..."] }` | Server-sent events: `data: { "content": "...", "model": "..." }` | Streams Orion AI chat responses through NVIDIA NIM. |

### Voice

| Method | Endpoint | Auth | Request body | Success response | Description |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/api/voice/transcribe` | Session | `multipart/form-data`: `audio` | `{ "success": true, "transcript": "transcribed text" }` | Transcribes audio through IBM Watson Speech to Text. |

## Request And Response Examples

### Check The Logged-In User

```bash
curl -i http://localhost:5000/api/auth/user
```

Example response when not logged in:

```json
{
  "loggedIn": false,
  "success": false,
  "user": null
}
```

Example response when logged in:

```json
{
  "loggedIn": true,
  "success": true,
  "user": {
    "sub": "app-id-user-sub",
    "userId": "app-id-user-sub",
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "picture": "https://example.com/avatar.png",
    "isAdmin": false,
    "roles": []
  }
}
```

### Sync Learning Session

```bash
curl -X PUT http://localhost:5000/api/user/sync-session \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"timeAdded":15,"pointsAdded":10,"activity":{"title":"Completed Docker tutorial","desc":"Finished lesson 1","icon":"BookOpen"}}'
```

Example response:

```json
{
  "success": true,
  "data": {
    "timeSpent": 120,
    "points": 50,
    "dailyTimeSpent": {
      "2026-05-25": 15
    },
    "activities": [
      {
        "title": "Completed Docker tutorial",
        "desc": "Finished lesson 1",
        "icon": "BookOpen",
        "time": "2026-05-25T10:00:00.000Z"
      }
    ]
  }
}
```

### Create A Community

```bash
curl -X POST http://localhost:5000/api/communities \
  -b cookies.txt \
  -F "name=Cloud Builders" \
  -F "description=A community for cloud learning" \
  -F "category=Cloud" \
  -F "visibility=public"
```

Example response:

```json
{
  "success": true,
  "community": {
    "_id": "community-id",
    "name": "Cloud Builders",
    "description": "A community for cloud learning",
    "visibility": "public",
    "member_count": 1
  }
}
```

### Create A Post

```bash
curl -X POST http://localhost:5000/api/posts/create \
  -b cookies.txt \
  -F "content=Learning IBM Cloud today" \
  -F "community_id=community-id"
```

Example response:

```json
{
  "success": true,
  "post": {
    "_id": "post-id",
    "content": "Learning IBM Cloud today",
    "community_id": "community-id",
    "likes": [],
    "like_count": 0
  }
}
```

### Send A Discussion Message

```bash
curl -X POST http://localhost:5000/api/discussions/channels/channel-id/messages \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"content":"Hello everyone"}'
```

Example response:

```json
{
  "success": true,
  "message": {
    "_id": "message-id",
    "channel_id": "channel-id",
    "sender_id": "user-id",
    "type": "text",
    "content": "Hello everyone",
    "pinned": false
  }
}
```

### Create A Lab

```bash
curl -X POST http://localhost:5000/api/labs/create \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"repoUrl":"https://github.com/owner/repo","labName":"cloudiq-node-lab","branch":"main"}'
```

Example response:

```json
{
  "success": true,
  "data": {
    "labId": "lab-id",
    "repoUrl": "https://github.com/owner/repo",
    "status": "active",
    "webUrl": "https://github.com/codespaces/..."
  },
  "webUrl": "https://github.com/codespaces/...",
  "labId": "lab-id",
  "message": "Lab created."
}
```

### Common Error Response

```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "You must be logged in to access this resource."
}
```

Other common status codes:

| Status | Meaning |
| --- | --- |
| `400` | Missing or invalid request body. |
| `401` | User is not logged in or GitHub is not connected. |
| `403` | User is logged in but does not have permission. |
| `404` | Requested document or route was not found. |
| `409` | Conflict, such as duplicate channel or active lab. |
| `413` | Uploaded file or request body is too large. |
| `429` | Cloudant rate limit was reached. |
| `500` | Server-side error. |
| `502` | AI provider failed. |
| `503` | A required service such as App ID, Cloudinary, or Firebase is not configured. |
| `504` | AI provider timed out. |

## Socket.IO Usage

Socket.IO is created in `server.js` and uses the same CORS origin configuration as Express.

### Client Connection

```js
import { io } from "socket.io-client";

const socket = io("http://localhost:5000", {
  withCredentials: true
});

socket.emit("register", {
  userId: "app-id-user-sub",
  email: "ada@example.com",
  username: "Ada",
  picture: "https://example.com/avatar.png"
});
```

### Core Socket Events

| Event | Direction | Payload | Description |
| --- | --- | --- | --- |
| `register` | Client to server | `{ userId/sub, email, username, picture }` | Registers the socket for direct notifications. |
| `socket_error` | Server to client | `{ code, message }` | Sent when socket registration is invalid. |
| `duplicate_session` | Server to client | `{ reason }` | Sent when a newer socket registers for the same user. |
| `watch_post` | Client to server | `postId` | Joins `post:<postId>` for realtime comments. |
| `unwatch_post` | Client to server | `postId` | Leaves `post:<postId>`. |
| `comment_created` | Server to client | `comment` | Broadcast after a new watched post comment. |
| `new_notification` | Server to client | `notification` | Direct notification for the registered user. |
| `friend_request` | Server to client | `{ message, sender_id, friendship_id }` | Realtime friend request. |
| `friend_accept` | Server to client | `{ message, receiver_id }` | Realtime friend accept event. |
| `stats_update` | Server to client | `stats` | Periodic platform stats. |
| `trending_update` | Server to client | `trending` | Periodic trending data. |

### Discussion Socket Events

| Event | Direction | Payload | Description |
| --- | --- | --- | --- |
| `join_community_discussions` | Client to server | `{ "community_id": "community-id" }` | Joins community-level discussion updates. |
| `leave_community_discussions` | Client to server | `{ "community_id": "community-id" }` | Leaves community discussion updates. |
| `join_channel` | Client to server | `{ "channel_id": "channel-id" }` | Joins a channel room after access validation. |
| `leave_channel` | Client to server | `{ "channel_id": "channel-id" }` | Leaves a channel room. |
| `typing_start` | Client to server | `{ "channel_id": "channel-id" }` | Broadcasts typing start. |
| `typing_stop` | Client to server | `{ "channel_id": "channel-id" }` | Broadcasts typing stop. |
| `new_message` | Client to server | `{ "channel_id": "channel-id", "content": "Hello", "client_temp_id": "tmp-1" }` | Sends a realtime text message. |
| `message_reaction` | Client to server | `{ "message_id": "message-id", "emoji": "thumbs_up", "action": "add" }` | Adds or removes a reaction. |
| `discussion_error` | Server to client | `{ code, message }` | Discussion socket error. |
| `channel_joined` | Server to client | `{ channel_id }` | Confirms channel join. |
| `join_leave_updates` | Server to client | `{ type, user_id, channel_id/community_id, at }` | Presence-style join/leave updates. |
| `new_message` | Server to client | `message` | Broadcast new channel message. |
| `unread_count_updates` | Server to client | `{ channel_id, unread_count }` | Unread count updates. |
| `message_reaction` | Server to client | `{ message_id, user_id, emoji, action }` | Broadcast reaction update. |

### Whiteboard Socket Events

| Event | Direction | Payload | Description |
| --- | --- | --- | --- |
| `whiteboard:create_room` | Client to server | `{ communityId, title }` | Creates a brainstorm room from socket. |
| `whiteboard:join_room` | Client to server | `{ roomId }` | Joins a whiteboard room. |
| `whiteboard:leave_room` | Client to server | `{ roomId }` | Leaves a whiteboard room. |
| `whiteboard:sync_canvas` | Client to server | `{ roomId, mutationId, whiteboard }` | Syncs whiteboard state with throttling. |
| `whiteboard:clear_canvas` | Client to server | `{ roomId, mutationId }` | Clears whiteboard state. |
| `whiteboard:add_sticky_note` | Client to server | `{ roomId, mutationId, note }` | Adds sticky note. |
| `whiteboard:add_connector` | Client to server | `{ roomId, mutationId, connector }` | Adds connector. |
| `whiteboard_error` | Server to client | `{ code, message }` | Whiteboard socket error. |
| `whiteboard:room_created` | Server to client | `{ room }` | Room creation result. |
| `whiteboard:room_joined` | Server to client | `{ roomId, room, whiteboard }` | Join result and current state. |
| `whiteboard:canvas_synced` | Server to client | `{ roomId, whiteboard, mutationId }` | Broadcast canvas update. |
| `whiteboard:canvas_cleared` | Server to client | `{ roomId, whiteboard, mutationId }` | Broadcast clear event. |
| `whiteboard:sticky_note_added` | Server to client | `{ roomId, note, mutationId }` | Broadcast new sticky note. |
| `whiteboard:connector_added` | Server to client | `{ roomId, connector, mutationId }` | Broadcast new connector. |
| `whiteboard:user_joined` | Server to client | `{ roomId, userId, at }` | User joined room. |
| `whiteboard:user_left` | Server to client | `{ roomId, userId, at }` | User left room. |

## How To Test APIs

### Postman

1. Start the backend with `npm run dev`.
2. Open `http://localhost:5000/api/auth/login` in a browser and finish App ID login.
3. Make sure Postman has cookies enabled for `localhost`.
4. Send requests to `http://localhost:5000/api/...`.
5. For protected APIs, include the saved `connect.sid` cookie.

### Thunder Client

1. Create an environment with `baseUrl=http://localhost:5000`.
2. Use `{{baseUrl}}/api/health` for the health check.
3. Login through the browser first.
4. Copy the `connect.sid` cookie if Thunder Client does not pick it up automatically.

### cURL Cookie Flow

Login is browser-based, so cURL is best for testing after you already have a valid cookie. For local manual testing, save cookies with a browser tool or API client and reuse them:

```bash
curl http://localhost:5000/api/auth/user -b cookies.txt
```

Public health check:

```bash
curl http://localhost:5000/api/health
```

Create a JSON request:

```bash
curl -X POST http://localhost:5000/api/friends/request \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"receiver_id":"target-user-id"}'
```

Upload form data:

```bash
curl -X POST http://localhost:5000/api/voice/transcribe \
  -b cookies.txt \
  -F "audio=@sample.webm"
```

## Deployment Guide

### Render

1. Create a new Web Service.
2. Connect the GitHub repository.
3. Set the runtime to Node.js.
4. Build command:

```bash
npm install
```

5. Start command:

```bash
npm start
```

6. Add all required environment variables in Render.
7. Set `NODE_ENV=production`.
8. Set `BACKEND_URL` to the Render backend URL.
9. Set `FRONTEND_URL` to the deployed frontend URL.
10. In IBM App ID, set callback URL to:

```text
https://your-backend-domain.com/api/auth/callback
```

11. In GitHub OAuth App settings, set callback URL to:

```text
https://your-backend-domain.com/api/github/callback
```

### Railway

1. Create a Railway project from the repository.
2. Add variables from the `.env` section.
3. Set the start command:

```bash
npm start
```

4. Use Railway's generated domain as `BACKEND_URL`.
5. Update App ID and GitHub OAuth callback URLs to use the Railway domain.

### VPS

1. Install Node.js 18+.
2. Clone the repository.
3. Install dependencies.

```bash
npm install
```

4. Create `.env` and add production values.
5. Start with a process manager.

```bash
npm install -g pm2
pm2 start server.js --name cloudiq-backend
pm2 save
```

6. Put Nginx or another reverse proxy in front of the app.
7. Enable HTTPS.
8. Set `BACKEND_URL` to the HTTPS domain.

### Docker

This repository does not include a Dockerfile. If you want Docker deployment, add one like this:

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

Build and run:

```bash
docker build -t cloudiq-backend .
docker run --env-file .env -p 5000:5000 cloudiq-backend
```

## Security Practices

- IBM App ID handles user authentication. Passwords are not stored by this backend.
- Passport stores authenticated users in the server-side session.
- Cookies are HTTP-only and become secure in production.
- CORS is restricted through `FRONTEND_URL` and `CORS_ALLOWED_ORIGINS`.
- Helmet is enabled with content security policy disabled for compatibility.
- Admin checks use `ADMIN_EMAILS` and the Cloudant `admins` database.
- File uploads use Multer memory storage and validate file type and size.
- Cloudinary public IDs are stripped from most frontend responses where they are internal.
- Logger redacts sensitive keys such as tokens, secrets, API keys, cookies, and private keys.
- Cloudant rate-limit errors are detected and retried once in the Cloudant client wrapper.
- There is no dedicated Express rate-limit middleware currently installed. Add one before exposing high-traffic public production endpoints.
- Rotate any secret that has ever been committed to git history.

## Troubleshooting

### Server exits immediately in production

`config/env.js` validates required production variables. If a required value is missing or invalid, the server exits.

Fix:

- Set every required production variable.
- Make `FRONTEND_URL`, `BACKEND_URL`, `APPID_REDIRECT_URI`, and `GITHUB_CALLBACK_URL` valid HTTPS URLs.
- Do not use localhost URLs in production.

### Cloudant is not configured

Error message:

```text
Cloudant is not configured. Missing environment variable(s): CLOUDANT_APIKEY, CLOUDANT_URL
```

Fix:

- Set `CLOUDANT_APIKEY`.
- Set `CLOUDANT_URL`.
- Restart the backend.
- Confirm the Cloudant service account can create databases and documents.

### Firebase private key errors

Fix:

- Keep `FIREBASE_PRIVATE_KEY` wrapped in quotes.
- Keep newline characters as `\n`.
- Make sure the service account belongs to `FIREBASE_PROJECT_ID`.

### Cloudinary uploads fail

Fix:

- Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`.
- Check upload file types and size limits.
- Restart the server after changing `.env`.

### App ID login redirects fail

Fix:

- `APPID_REDIRECT_URI` must exactly match the IBM App ID application callback URL.
- Local callback should usually be `http://localhost:5000/api/auth/callback`.
- Production callback should be `https://your-backend-domain.com/api/auth/callback`.
- Remove trailing slashes if the provider dashboard does not include them.

### Cookies are not saved in the browser

Fix:

- Frontend requests must use `credentials: "include"`.
- Backend CORS must allow the exact frontend origin.
- Production must use HTTPS because cookies are `secure`.
- Set `FRONTEND_URL` and `BACKEND_URL` correctly.

### CORS errors

Fix:

- Add the frontend origin to `FRONTEND_URL` or `CORS_ALLOWED_ORIGINS`.
- Do not include a trailing slash.
- Restart the backend.

### Port already in use

Use a different port:

```env
PORT=5001
```

Or stop the process already using port `5000`.

### GitHub labs require login

Fix:

- Log in to the main app first.
- Visit `/api/github/login` to connect GitHub.
- Ensure GitHub OAuth callback is `/api/github/callback`.
- Make sure the GitHub OAuth app has access to Codespaces scopes.

### Orion AI returns `502` or `504`

Fix:

- Check `ORION_API_KEY`.
- Confirm the model name includes the publisher prefix, such as `moonshotai/kimi-k2-instruct`.
- Increase `ORION_API_TIMEOUT_MS` if responses are slow.
- Check NVIDIA API availability.

### Voice transcription returns configuration error

Fix:

- Set `WATSON_STT_API_KEY`.
- Set `WATSON_STT_URL`.
- Upload supported audio types such as `webm`, `wav`, `mp3`, `flac`, `ogg`, or `mp4`.

## Contribution Guide

1. Create a feature branch.

```bash
git checkout -b feature/your-feature-name
```

2. Install dependencies.

```bash
npm install
```

3. Run the backend locally.

```bash
npm run dev
```

4. Keep route changes documented in this README.
5. Use the existing middleware and service patterns.
6. Avoid committing `.env`, service account files, private keys, or generated credentials.
7. Open a pull request with:

- What changed.
- Why it changed.
- How it was tested.
- Any new environment variables.

## License

MIT License. Add the final license file before publishing the repository.

## Contact

Maintainer details are not defined in the codebase yet.

- GitHub: `https://github.com/your-org`
- LinkedIn: `https://linkedin.com/in/your-profile`
- Email: `your-email@example.com`
