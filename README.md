# CloudIQ Backend

CloudIQ Backend is the Express.js API server for CloudIQ. It handles IBM App ID authentication, Cloudant documents, Firebase Firestore and Realtime Database persistence, Socket.IO realtime features, Cloudinary media storage, Orion AI, tutorials, community discussions, posts, comments, notifications, and GitHub Codespaces labs.

This repository is backend-only.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```powershell
Copy-Item .env.example .env
```

On macOS/Linux:

```bash
cp .env.example .env
```

3. Fill in `.env` with IBM App ID, Cloudant, Firebase, Cloudinary, Orion, Watson, GitHub, and session values.

4. Start the backend:

```bash
npm run dev
```

The backend defaults to:

```text
http://localhost:5000
```

## Scripts

```bash
npm run dev
npm start
```

- `npm run dev` starts `nodemon server.js`.
- `npm start` starts `node server.js`.

There is no test script configured yet. Use `node --check` for syntax validation after backend changes.

## Required Services

CloudIQ depends on these external services:

- IBM App ID for login and session identity
- IBM Cloudant for core document storage
- Firebase Firestore for discussion metadata, messages, brainstorm room metadata, and AI generations
- Firebase Realtime Database for live whiteboard state
- Cloudinary for media uploads
- NVIDIA NIM for Orion AI
- IBM Watson Speech to Text for voice transcription
- GitHub OAuth and Codespaces for labs

## Environment Variables

Copy `.env.example` to `.env` and configure the following groups.

### Server

```env
PORT=5000
NODE_ENV=development
LOG_LEVEL=info
SESSION_SECRET=replace-with-a-long-random-secret
FRONTEND_URL=http://localhost:5173
BACKEND_URL=http://localhost:5000
```

`FRONTEND_URL` is used for CORS and auth redirects.

### IBM App ID

```env
APPID_TENANT_ID=...
APPID_CLIENT_ID=...
APPID_SECRET=...
APPID_OAUTH_SERVER_URL=...
APPID_REDIRECT_URI=http://localhost:5000/auth/callback
APPID_DISCOVERY_ENDPOINT=...
APPID_PROFILES_URL=...
APPID_MANAGEMENT_URL=...
APPID_API_KEY=...
ADMIN_ROLE_ID=...
ADMIN_ROLE_NAME=admin
```

The canonical user identity in backend permission checks is `user.sub`.

### Cloudant

```env
CLOUDANT_APIKEY=...
CLOUDANT_URL=...
```

The backend initializes required databases and design documents on startup when credentials are present.

Expected databases include:

- `users`
- `posts`
- `comments`
- `notifications`
- `communities`
- `community_requests`
- `community_memberships`
- `friendships`
- `admins`
- `tutorials`
- `tutorial_media`
- `upload_metadata`
- `lab_sessions`

### Firebase

```env
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://your-project-id-default-rtdb.firebaseio.com
```

Firestore is used for discussions and brainstorm metadata. Realtime Database is used for live whiteboard state.

### Cloudinary

```env
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

Cloudinary stores:

- post images in `cloudiq/posts/images`
- post videos in `cloudiq/posts/videos`
- discussion media
- tutorial media
- profile/community images

### Orion AI

```env
ORION_API_KEY=nvapi-...
ORION_MODEL=moonshotai/kimi-k2-instruct
ORION_VISION_MODEL=meta/llama-3.2-11b-vision-instruct
ORION_API_TIMEOUT_MS=60000
```

`ORION_MODEL` must include the publisher prefix, for example `moonshotai/kimi-k2-instruct`.

### GitHub Codespaces Labs

```env
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_CALLBACK_URL=http://localhost:5000/api/github/callback
GITHUB_API_VERSION=2026-03-10
LAB_TTL_MINUTES=30
LAB_TOKEN_ENCRYPTION_KEY=replace-with-a-long-random-secret-used-only-for-lab-token-encryption
```

`LAB_TOKEN_ENCRYPTION_KEY` encrypts GitHub access tokens stored for cleanup. Never expose it to the frontend.

## Project Structure

```text
server.js                         Express, sessions, Passport, Socket.IO, route mounting
middleware/auth.js                Auth helpers and admin checks
routes/                           HTTP route modules
sockets/                          Socket.IO feature handlers
services/cloudantClient.js        Cloudant startup and design docs
services/firebaseService.js       Firestore and Realtime Database access
services/cloudinaryService.js     Cloudinary uploads/deletes
services/mediaService.js          Media metadata wrappers
services/brainstormService.js     Brainstorm rooms, whiteboard sync, Orion AI storage
services/labCleanupService.js     Expired Codespaces cleanup cron
utils/logger.js                   Structured logging helpers
```

## Authentication

IBM App ID is the primary login system.

Auth flow:

1. Frontend redirects to `GET /auth/login`.
2. IBM App ID authenticates the user.
3. IBM redirects to `GET /auth/callback`.
4. Backend creates an Express session.
5. Frontend calls `GET /auth/user` to restore session state.

Important rules:

- API routes use `ensureAuthenticated`.
- Permission-sensitive storage should use `extractUserInfo(req.user).userId`.
- `userId` should resolve from IBM App ID `sub`.
- Do not use email, username, or membership document ids as the canonical permission identity.

## API Route Map

### Auth

```text
GET  /auth/login
GET  /auth/callback
GET  /auth/logout
GET  /auth/user
GET  /auth/status
```

### User

```text
GET    /api/user/profile
PUT    /api/user/profile
POST   /api/user/onboarding
DELETE /api/user/profile-image
DELETE /api/user/account
```

### Communities

```text
GET    /api/communities
POST   /api/communities
PUT    /api/communities/:id
DELETE /api/communities/:id
POST   /api/communities/:id/join
POST   /api/communities/:id/leave
POST   /api/communities/:id/request
GET    /api/communities/:id/requests
POST   /api/communities/:id/requests/:requestId/approve
POST   /api/communities/:id/requests/:requestId/reject
```

Community membership is persisted in `community_memberships`. Discussion and brainstorming access should validate membership through this source.

### Posts

```text
GET    /api/posts
POST   /api/posts/create
DELETE /api/posts/:id
POST   /api/posts/:id/like
```

Post media supports:

- image uploads
- video uploads
- mixed media posts with image plus video

Supported image types:

```text
image/jpeg
image/png
image/webp
```

Supported video types:

```text
video/mp4
video/webm
video/quicktime
```

Limits:

- images: 5 MB
- videos: 100 MB

Post media metadata includes both legacy and modern fields:

```json
{
  "image_url": "https://...",
  "image_public_id": "cloudiq/posts/images/...",
  "video_url": "https://...",
  "video_public_id": "cloudiq/posts/videos/...",
  "media_type": "video",
  "mediaUrl": "https://...",
  "mediaType": "video",
  "mediaPublicId": "cloudiq/posts/videos/...",
  "media": [
    {
      "type": "video",
      "url": "https://...",
      "publicId": "cloudiq/posts/videos/...",
      "resourceType": "video"
    }
  ]
}
```

When a post is deleted, Cloudinary media cleanup runs before Cloudant metadata deletion.

### Comments, Friends, Notifications

```text
POST   /api/comments/create
DELETE /api/comments/:id

GET    /api/friends
GET    /api/friends/discover
POST   /api/friends/request
POST   /api/friends/accept
POST   /api/friends/reject
DELETE /api/friends/:id

GET    /api/notifications
PATCH  /api/notifications/:id/read
```

### Tutorials

```text
GET    /api/tutorials
GET    /api/tutorials/:id
POST   /api/tutorials
PUT    /api/tutorials/:id
DELETE /api/tutorials/:id
POST   /api/tutorials/upload-inline-image
POST   /api/tutorials/upload-inline-media
DELETE /api/tutorials/image
```

Tutorials support Cloudinary image and video media. Admin and community moderator rules are enforced in the route.

### Discussions

```text
GET    /api/discussions/communities/:communityId/channels
POST   /api/discussions/communities/:communityId/channels
DELETE /api/discussions/communities/:communityId/channels/:channelId
GET    /api/discussions/channels/:channelId/messages
POST   /api/discussions/channels/:channelId/messages
POST   /api/discussions/channels/:channelId/media
POST   /api/discussions/messages/:messageId/pin
POST   /api/discussions/messages/:messageId/unpin
POST   /api/discussions/messages/:messageId/reactions
POST   /api/discussions/channels/:channelId/read
GET    /api/discussions/communities/:communityId/unreads
```

Firestore stores discussion channels, messages, reactions, unread states, typing, and presence.

Discussion media uploads use Cloudinary.

### Orion Chat

```text
POST /api/orion/chat
```

This route streams Orion chat responses over Server-Sent Events.

### Brainstorming

```text
POST   /api/brainstorm/rooms
GET    /api/brainstorm/rooms/:roomId
POST   /api/brainstorm/rooms/:roomId/join
POST   /api/brainstorm/rooms/:roomId/leave
POST   /api/brainstorm/rooms/:roomId/sync
POST   /api/brainstorm/rooms/:roomId/clear
POST   /api/brainstorm/rooms/:roomId/notes
POST   /api/brainstorm/rooms/:roomId/connectors
DELETE /api/brainstorm/rooms/:roomId
POST   /api/brainstorm/ai/generate
POST   /api/brainstorm/ai/expand
POST   /api/brainstorm/ai/project
```

Brainstorming uses:

- Firebase Realtime Database for live whiteboard state
- Firestore `brainstorm_sessions` for room metadata
- Firestore `brainstorm_ai_generations` for Orion AI responses
- Cloudant `community_memberships` for access checks

Create room request:

```json
{
  "communityId": "community-id",
  "title": "AI Cloud Startup Ideas"
}
```

Whiteboard sync request:

```json
{
  "whiteboard": {
    "strokes": [],
    "shapes": [],
    "notes": [],
    "connectors": []
  }
}
```

Sticky note request:

```json
{
  "note": {
    "text": "Use serverless inference",
    "x": 120,
    "y": 240,
    "color": "#fff3a3"
  }
}
```

Connector request:

```json
{
  "connector": {
    "from": "note-a",
    "to": "note-b",
    "label": "feeds",
    "points": [{ "x": 10, "y": 20 }]
  }
}
```

AI generate request:

```json
{
  "roomId": "optional-room-id",
  "prompt": "Startup ideas using AI + Cloud"
}
```

AI responses are stored in Firestore:

```text
brainstorm_ai_generations/{generationId}
```

Stored fields include:

```json
{
  "userId": "ibm-app-id-sub",
  "roomId": "room-id",
  "action": "generate",
  "prompt": "...",
  "response": "...",
  "model": "moonshotai/kimi-k2-instruct",
  "createdAt": "..."
}
```

Security and performance rules:

- All brainstorm REST routes require authentication.
- Room creation requires community membership or admin status.
- Room access validates community membership.
- Room deletion is limited to the room owner or admin.
- AI requests are rate-limited per user.
- Whiteboard payloads are size-limited.
- Drawing updates should be batched/debounced by the frontend.
- Do not write to Firestore on every mouse movement; use Realtime Database for live state and Firestore only for stable metadata.

### Voice

```text
POST /api/voice/transcribe
```

Requires IBM Watson Speech to Text credentials.

### GitHub OAuth and Labs

```text
GET    /api/github/login
GET    /api/github/callback
GET    /api/github/status
POST   /api/github/logout

GET    /api/labs
POST   /api/labs/create
DELETE /api/labs
DELETE /api/labs/:labId
```

Labs let authenticated users connect GitHub, provide a public repository URL, and launch a temporary Codespace.

Create lab request:

```json
{
  "repoUrl": "https://github.com/octocat/Hello-World"
}
```

Rules:

- IBM App ID session is still required.
- GitHub OAuth is only for Codespaces access.
- Private repositories are rejected.
- One active lab per user is allowed.
- Labs expire after `LAB_TTL_MINUTES`.
- Cleanup runs every 5 minutes.
- Encrypted GitHub tokens are never returned by the API.

## Socket.IO

Socket.IO is initialized in `server.js`.

Clients should register after connecting:

```js
socket.emit("register", {
  sub: user.sub,
  userId: user.userId,
  email: user.email,
  username: user.username,
  picture: user.picture
});
```

Use `sub`/`userId` from the authenticated IBM App ID session.

### Discussion Socket Events

```text
join_community_discussions
leave_community_discussions
join_channel
leave_channel
typing_start
typing_stop
new_message
message_reaction
```

Errors are emitted as:

```text
discussion_error
```

### Whiteboard Socket Events

Client emits:

```text
whiteboard:create_room
whiteboard:join_room
whiteboard:leave_room
whiteboard:sync_canvas
whiteboard:clear_canvas
whiteboard:add_sticky_note
whiteboard:add_connector
```

Server emits:

```text
whiteboard:room_created
whiteboard:room_joined
whiteboard:user_joined
whiteboard:user_left
whiteboard:canvas_synced
whiteboard:canvas_cleared
whiteboard:sticky_note_added
whiteboard:connector_added
whiteboard_error
```

To avoid infinite sync loops, include a client-generated `mutationId` in outgoing whiteboard events and ignore echoed updates that match the local pending mutation. The server also includes `sourceSocketId` in broadcast payloads.

Example:

```js
socket.emit("whiteboard:sync_canvas", {
  roomId,
  mutationId: crypto.randomUUID(),
  whiteboard: {
    strokes,
    shapes,
    notes,
    connectors
  }
});
```

The frontend should debounce drawing sync. A good starting point is 250-500 ms or sync on stroke end.

## Logging

Use professional logs only. Important log markers include:

```text
[POSTS] video upload started
[POSTS] video upload completed
[POSTS] post created
[WHITEBOARD] room synced
[WHITEBOARD] user joined
[ORION] generation completed
[ORION] expand request failed
```

Avoid logging:

- raw tokens
- full private keys
- entire uploaded files
- full AI prompts when sensitive
- high-frequency mouse movement events

## Local Development Checklist

1. Start backend:

```bash
npm run dev
```

2. Start the frontend from the frontend repository.

3. Log in through IBM App ID.

4. Confirm:

- `GET /auth/user` returns a logged-in session.
- communities load
- discussions load
- posts load
- tutorials load
- Socket.IO registration succeeds

5. For posts:

- create a text post
- create an image post
- create a video post under 100 MB
- create a mixed image and video post
- delete a media post and confirm Cloudinary cleanup

6. For brainstorming:

- create a room inside a community where the user is a member
- join the room over REST or Socket.IO
- sync a canvas payload
- add a sticky note
- add a connector
- reload and confirm whiteboard state persists
- call `/api/brainstorm/ai/generate`
- confirm a document appears in `brainstorm_ai_generations`

7. For labs:

- connect GitHub
- create a Codespace from a public repository
- refresh and confirm the active lab persists
- delete the lab

## Validation Commands

Run syntax checks after backend edits:

```bash
node --check server.js
node --check middleware/auth.js
node --check routes/posts.js
node --check routes/discussions.js
node --check routes/brainstorm.js
node --check routes/tutorials.js
node --check sockets/discussions.js
node --check sockets/whiteboard.js
node --check services/firebaseService.js
node --check services/brainstormService.js
node --check services/cloudinaryService.js
node --check services/mediaService.js
```

If Firebase writes fail on Windows with gRPC or path-related errors, verify the Node version and local path first. Prefer Node 20 LTS and a short checkout path.

## Deployment Notes

### Render Backend

Set production environment variables:

```env
NODE_ENV=production
FRONTEND_URL=https://your-frontend-domain
BACKEND_URL=https://your-backend-domain
APPID_REDIRECT_URI=https://your-backend-domain/auth/callback
GITHUB_CALLBACK_URL=https://your-backend-domain/api/github/callback
```

Also configure:

- IBM App ID credentials
- Cloudant credentials
- Firebase service account values
- Firebase Realtime Database URL
- Cloudinary credentials
- Orion API key
- Watson credentials
- GitHub OAuth credentials
- `SESSION_SECRET`
- `LAB_TOKEN_ENCRYPTION_KEY`

Because cross-site cookies are used between frontend hosting and backend hosting, keep production session cookie settings aligned with HTTPS.

### Frontend Environment

Typical frontend variables:

```env
VITE_BACKEND_URL=https://your-backend-domain
VITE_API_URL=https://your-backend-domain
```

If using a frontend proxy, route `/api/*` and `/auth/*` to the backend.

## Safety Rules For Future Backend Changes

- Do not rewrite auth, discussions, posts, tutorials, labs, or communities for unrelated features.
- Preserve `user.sub` as the canonical permission identity.
- Align REST and Socket.IO authorization for realtime features.
- Keep Firestore discussion persistence intact.
- Keep Cloudinary cleanup paths intact.
- Use Realtime Database for high-frequency whiteboard state.
- Use Firestore for durable room metadata and AI generation history.
- Keep changes small and validate touched files with `node --check`.
