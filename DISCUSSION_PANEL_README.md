# CloudIQ Discussion Panel README

This document explains how the CloudIQ discussion panel works from the frontend point of view, while matching the current backend implementation.

The discussion system is a Discord-style community chat panel. Community metadata and membership validation still use Cloudant. Realtime discussion data uses Firebase Firestore. Discussion media uploads use Cloudinary.

## Architecture

The discussion panel uses four backend pieces:

1. Authentication
   - All discussion APIs require the existing `ensureAuthenticated` middleware.
   - User identity comes from the backend auth session.
   - Permission checks use the canonical backend user id from `extractUserInfo(req.user).userId`.

2. Community access
   - Community documents are loaded from Cloudant.
   - Membership is validated before channels or messages are returned.
   - Admins and community moderators can create and delete channels.
   - Joined community members can read channels and send messages.

3. Firestore discussion data
   - Firestore stores:
     - `channels`
     - `messages`
     - `typing`
     - `presence`
     - `unread_states`
     - `reactions`
   - Firestore is the persistent source for channel and message history.

4. Cloudinary media storage
   - Chat images, videos, PDFs, and text files upload to Cloudinary.
   - Firestore stores only the media metadata and URL.
   - No local files or temp files are used for discussion uploads.

## Data Flow

### Channel Load

Frontend requests channels for a community:

```http
GET /api/discussions/communities/:communityId/channels
```

Backend:

1. Authenticates the user.
2. Loads the community from Cloudant.
3. Validates membership/admin access.
4. Loads channels from Firestore.
5. Creates a default `general` channel if no channel exists.
6. Returns channels visible to the user.

Response:

```json
{
  "success": true,
  "channels": [
    {
      "_id": "channel-id",
      "id": "channel-id",
      "community_id": "community-id",
      "communityId": "community-id",
      "name": "general",
      "topic": "Welcome to the community discussion",
      "type": "text",
      "visibility": "members",
      "position": 0,
      "created_by": "user-id",
      "createdBy": "user-id",
      "created_at": "2026-05-10T00:00:00.000Z",
      "createdAt": "2026-05-10T00:00:00.000Z"
    }
  ]
}
```

### Message History Load

Frontend requests the latest messages for the selected channel:

```http
GET /api/discussions/channels/:channelId/messages?limit=30
```

Optional pagination:

```http
GET /api/discussions/channels/:channelId/messages?limit=30&before=2026-05-10T00:00:00.000Z
```

Backend:

1. Authenticates the user.
2. Validates channel access.
3. Queries Firestore messages by `communityId` and `channelId`.
4. Returns latest messages in chronological order.

Response:

```json
{
  "success": true,
  "messages": [
    {
      "_id": "message-id",
      "id": "message-id",
      "community_id": "community-id",
      "communityId": "community-id",
      "channel_id": "channel-id",
      "channelId": "channel-id",
      "sender_id": "user-id",
      "senderId": "user-id",
      "sender_name": "Ada",
      "senderName": "Ada",
      "sender_avatar": null,
      "senderAvatar": null,
      "type": "text",
      "content": "Hello",
      "text": "Hello",
      "media": null,
      "created_at": "2026-05-10T00:00:00.000Z",
      "createdAt": "2026-05-10T00:00:00.000Z"
    }
  ]
}
```

## REST API Contract

Base route:

```text
/api/discussions
```

### List Channels

```http
GET /api/discussions/communities/:communityId/channels
```

Use this when:

- Opening the discussion panel.
- Refreshing community channel state.
- Recovering after socket reconnect.

### Create Channel

```http
POST /api/discussions/communities/:communityId/channels
Content-Type: application/json
```

Body:

```json
{
  "name": "general",
  "topic": "Optional topic",
  "type": "text",
  "visibility": "members"
}
```

Rules:

- Only creator/admin/moderator can create channels.
- Channel names are normalized to lowercase slug style.
- Duplicate channel names return `409`.

### Delete Channel

```http
DELETE /api/discussions/communities/:communityId/channels/:channelId
```

Backend cleanup:

- Deletes Cloudinary media for messages in the channel.
- Deletes Firestore messages.
- Deletes typing states.
- Deletes reactions.
- Deletes unread states.
- Deletes the channel document.

### Send Text Message

```http
POST /api/discussions/channels/:channelId/messages
Content-Type: application/json
```

Body:

```json
{
  "content": "Hello everyone"
}
```

Also accepted:

```json
{
  "text": "Hello everyone"
}
```

Response:

```json
{
  "success": true,
  "message": {
    "_id": "message-id",
    "channel_id": "channel-id",
    "community_id": "community-id",
    "sender_id": "user-id",
    "sender_name": "Ada",
    "type": "text",
    "content": "Hello everyone",
    "text": "Hello everyone"
  }
}
```

### Upload Media Message

```http
POST /api/discussions/channels/:channelId/media
```

Frontend must use `FormData`.

Required field name:

```js
formData.append("file", selectedFile);
```

Do not manually set `Content-Type`. The browser must generate the multipart boundary.

Correct frontend example:

```js
const formData = new FormData();
formData.append("file", selectedFile);

const response = await fetch(`/api/discussions/channels/${channelId}/media`, {
  method: "POST",
  credentials: "include",
  body: formData
});
```

Incorrect:

```js
await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "multipart/form-data"
  },
  body: formData
});
```

Supported file types:

- `image/jpeg`
- `image/png`
- `image/webp`
- `image/gif`
- `video/mp4`
- `video/webm`
- `video/quicktime`
- `video/x-m4v`
- `application/pdf`
- `text/plain`

Size limits:

- Images: 10 MB
- Videos: 50 MB
- PDF/text files: 25 MB

Backend behavior:

1. Parses the file with `multer.memoryStorage()`.
2. Validates `req.file.buffer`.
3. Uploads the in-memory buffer to Cloudinary with `upload_stream`.
4. Stores Cloudinary metadata in Firestore.
5. Emits `new_message` over Socket.IO.

Media message fields:

```json
{
  "type": "image",
  "mediaUrl": "https://res.cloudinary.com/...",
  "media_url": "https://res.cloudinary.com/...",
  "mediaType": "image",
  "media_type": "image",
  "mediaPublicId": "cloudiq/discussions/community/channel/file",
  "media_public_id": "cloudiq/discussions/community/channel/file",
  "mediaResourceType": "image",
  "media_resource_type": "image",
  "fileName": "screenshot.png",
  "file_name": "screenshot.png",
  "media": {
    "url": "https://res.cloudinary.com/...",
    "secure_url": "https://res.cloudinary.com/...",
    "public_id": "cloudiq/discussions/community/channel/file",
    "resource_type": "image",
    "media_type": "image",
    "mime_type": "image/png",
    "size_bytes": 12345,
    "filename": "screenshot.png"
  }
}
```

### Pin Message

```http
POST /api/discussions/messages/:messageId/pin
```

Only moderators/admins can pin.

### Unpin Message

```http
POST /api/discussions/messages/:messageId/unpin
```

Only moderators/admins can unpin.

### React to Message

```http
POST /api/discussions/messages/:messageId/reactions
Content-Type: application/json
```

Body:

```json
{
  "emoji": "👍",
  "action": "add"
}
```

Remove reaction:

```json
{
  "emoji": "👍",
  "action": "remove"
}
```

### Mark Channel Read

```http
POST /api/discussions/channels/:channelId/read
```

Resets unread count for the current user.

### Get Unread Counts

```http
GET /api/discussions/communities/:communityId/unreads
```

Response:

```json
{
  "success": true,
  "unreads": [
    {
      "channel_id": "channel-id",
      "unread_count": 3
    }
  ]
}
```

## Socket.IO Contract

Socket.IO is lightweight. It should not replace REST history loading.

Use REST for:

- Initial channel list
- Initial message history
- Media upload
- Channel creation/deletion
- Message pin/unpin

Use Socket.IO for:

- Joining realtime rooms
- Receiving new messages
- Typing indicators
- Presence
- Reactions
- Unread updates

### Join Community Discussion Room

Client emits:

```js
socket.emit("join_community_discussions", {
  community_id: communityId
});
```

Backend validates membership and joins:

```text
community:communityId
```

### Join Channel Room

Client emits:

```js
socket.emit("join_channel", {
  channel_id: channelId
});
```

Backend validates channel access and joins:

```text
channel:channelId
```

### New Message Event

Backend emits:

```js
socket.on("new_message", (message) => {
  // append or reconcile message in UI
});
```

Text messages and media messages both use this event.

### Typing Events

Client emits:

```js
socket.emit("typing_start", { channel_id: channelId });
socket.emit("typing_stop", { channel_id: channelId });
```

Client listens:

```js
socket.on("typing_start", ({ channel_id, user_id }) => {});
socket.on("typing_stop", ({ channel_id, user_id }) => {});
```

### Reaction Event

Client listens:

```js
socket.on("message_reaction", (payload) => {});
```

### Unread Event

Client listens:

```js
socket.on("unread_count_updates", (payload) => {});
```

### Error Event

Client listens:

```js
socket.on("discussion_error", (error) => {
  console.warn(error.code, error.message);
});
```

## Frontend State Model

Recommended state:

```ts
type DiscussionState = {
  channels: Channel[];
  selectedChannelId: string | null;
  messagesByChannelId: Record<string, Message[]>;
  unreadsByChannelId: Record<string, number>;
  loadingChannels: boolean;
  loadingMessages: boolean;
  sendingMessage: boolean;
  uploadingMedia: boolean;
  typingUsersByChannelId: Record<string, string[]>;
};
```

Recommended frontend flow:

1. User opens community.
2. Fetch channels with `GET /communities/:communityId/channels`.
3. Select first channel if no channel is selected.
4. Fetch latest 30 messages for selected channel.
5. Join community socket room.
6. Join selected channel socket room.
7. Append `new_message` events to the selected channel cache.
8. On media upload success, use the returned message and also reconcile the socket event by message id.
9. On channel switch, fetch messages if not already cached or if cache is stale.
10. On refresh, repeat channel and message fetches from REST.

## Message Rendering Rules

Render by `message.type` and media fields.

Text:

```js
message.type === "text"
```

Use:

```js
message.text || message.content
```

Image:

```js
message.type === "image" || message.mediaType === "image"
```

Use:

```js
message.mediaUrl || message.media?.secure_url || message.media?.url
```

Video:

```js
message.type === "video" || message.mediaType === "video"
```

Use an HTML `<video controls />`.

PDF or text attachment:

```js
message.type === "attachment"
```

Render as a download/open link using:

```js
message.mediaUrl || message.media?.secure_url || message.media?.url
```

## Important Frontend Upload Notes

The media upload crash was caused by storage stream instability. The backend now expects in-memory multipart uploads only.

Frontend must:

- Use `FormData`.
- Append file under key `"file"`.
- Include credentials/session cookies.
- Not set `Content-Type` manually.
- Disable upload button while uploading.
- Show progress or spinner.
- Optimistically show a pending message only if the UI can reconcile by returned message id.

Recommended upload function:

```js
async function uploadDiscussionMedia(channelId, file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`/api/discussions/channels/${channelId}/media`, {
    method: "POST",
    credentials: "include",
    body: formData
  });

  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Upload failed");
  }

  return data.message;
}
```

## Error Handling

Expected backend errors:

```json
{
  "success": false,
  "error": "Unsupported discussion media type",
  "code": "unsupported_media"
}
```

Common codes:

- `missing_file`
- `invalid_file`
- `invalid_file_buffer`
- `unsupported_media`
- `file_too_large`
- `cloudinary_unavailable`
- `upload_failed`
- `media_upload_error`

Frontend should display friendly messages:

- Unsupported file: "This file type is not supported."
- Too large: "This file is too large."
- Upload failed: "Upload failed. Please try again."
- Unauthorized: "You do not have access to this channel."

## Backend Logs

Expected logs during successful media upload:

```text
[CLOUDINARY] upload request received
[CLOUDINARY] multer parsed successfully
[CLOUDINARY] buffer validated
[CLOUDINARY] buffer type valid
[CLOUDINARY] upload stream started
[CLOUDINARY] upload stream starting
[CLOUDINARY] upload completed
[CLOUDINARY] secure URL generated
[CLOUDINARY] firestore message stored
[FIREBASE] message broadcast complete
[CLOUDINARY] media synced realtime
```

If upload fails:

```text
[CLOUDINARY] upload failed
[DISCUSSIONS] Cloudinary upload failed
```

The frontend should receive a clean JSON response, not a backend crash.

## Copy-Ready Frontend Prompt

Use this prompt for the frontend task:

```text
Update the CloudIQ discussion panel frontend to use the backend discussion API correctly.

Requirements:

1. Load channels from:
   GET /api/discussions/communities/:communityId/channels

2. Select the first channel automatically when no selected channel exists.

3. Load messages from:
   GET /api/discussions/channels/:channelId/messages?limit=30

4. Send text messages to:
   POST /api/discussions/channels/:channelId/messages
   Body: { content: messageText }

5. Upload media to:
   POST /api/discussions/channels/:channelId/media

   Use FormData:
   const formData = new FormData();
   formData.append("file", selectedFile);

   Do not manually set Content-Type.
   Include credentials: "include".

6. Render media messages using:
   message.mediaUrl || message.media?.secure_url || message.media?.url

7. Render:
   images as img
   videos as video controls
   PDFs/text files as attachment links

8. Use Socket.IO only for realtime updates:
   join_community_discussions
   join_channel
   new_message
   typing_start
   typing_stop
   message_reaction
   unread_count_updates
   discussion_error

9. Reconcile duplicate optimistic/socket messages by message id.

10. Show upload spinner, disable upload button while uploading, and show friendly errors for:
    unsupported_media
    file_too_large
    cloudinary_unavailable
    upload_failed

Do not break existing authentication, community routing, active channel display, message history, or realtime chat behavior.
```
