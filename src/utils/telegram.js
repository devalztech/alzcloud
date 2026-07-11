/**
 * AlzCloud — MTProto File Storage
 * Uses GramJS (Telegram user client) for 2GB upload/download limit.
 * Credentials are read from env — see TELEGRAM_API_ID / TELEGRAM_API_HASH below.
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const { CustomFile } = require('telegram/client/uploads');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ── MTProto credentials (from my.telegram.org/apps) ──────────────────────────
// Read from env only — these grant full access to the uploader's Telegram
// account and must never be hardcoded in source again. The old pair was
// committed to this repo's git history; treat it as burned and generate a
// fresh app at my.telegram.org, then set these two on Render.
const API_ID = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;

if (!API_ID || !API_HASH) {
  throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in the environment.');
}

// ── Singleton client ──────────────────────────────────────────────────────────
let _client = null;

async function getClient() {
  if (_client && _client.connected) return _client;

  const sessionStr = process.env.TELEGRAM_SESSION || '';
  const session = new StringSession(sessionStr);

  _client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 1000,
    autoReconnect: true,
    // Suppress interactive prompts in production
    // GramJS calls .info(), .debug(), .warn(), .error() internally — stub all of them
    baseLogger: { log: () => {}, info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }
  });

  await _client.connect();

  if (!await _client.checkAuthorization()) {
    throw new Error(
      'Telegram session is not authorized. ' +
      'Run `node scripts/gen_session.js` to generate a TELEGRAM_SESSION string, ' +
      'then add it to your .env file.'
    );
  }

  return _client;
}

// ── Get the peer for your storage channel ────────────────────────────────────
function getChannelPeer() {
  const rawId = process.env.TELEGRAM_CHANNEL_ID; // e.g. -1001234567890
  if (!rawId) throw new Error('TELEGRAM_CHANNEL_ID is not set in .env');
  // Strip the -100 prefix to get the bare channel id
  const numId = BigInt(rawId.toString().replace(/^-100/, ''));
  return new Api.InputPeerChannel({
    channelId: numId,
    accessHash: BigInt(0) // GramJS resolves this automatically via entity cache
  });
}

// ── Upload a file buffer → returns { message_id, file_id, file_unique_id } ───
const uploadFile = async (buffer, filename, mimeType) => {
  const client = await getClient();

  // Write buffer to a temp file so GramJS can stream it
  const tmpPath = path.join('/tmp', `alz_upload_${Date.now()}_${filename}`);
  fs.writeFileSync(tmpPath, buffer);

  try {
    const isVideo   = mimeType && mimeType.startsWith('video/');
    const isPhoto   = mimeType && mimeType.startsWith('image/') && !mimeType.includes('gif');
    const isAudio   = mimeType && mimeType.startsWith('audio/');

    const customFile = new CustomFile(
      filename,
      fs.statSync(tmpPath).size,
      tmpPath
    );

    const uploadedFile = await client.uploadFile({
      file: customFile,
      workers: 4,   // parallel upload workers — speeds up large files
    });

    let message;

    if (isPhoto) {
      message = await client.sendFile(process.env.TELEGRAM_CHANNEL_ID, {
        file: uploadedFile,
        caption: filename,
        forceDocument: false,
      });
    } else if (isVideo) {
      message = await client.sendFile(process.env.TELEGRAM_CHANNEL_ID, {
        file: uploadedFile,
        caption: filename,
        attributes: [
          new Api.DocumentAttributeVideo({
            duration: 0,
            w: 0,
            h: 0,
            supportsStreaming: true,
          }),
        ],
        forceDocument: false,
      });
    } else if (isAudio) {
      message = await client.sendFile(process.env.TELEGRAM_CHANNEL_ID, {
        file: uploadedFile,
        caption: filename,
        attributes: [
          new Api.DocumentAttributeAudio({
            duration: 0,
            title: filename,
          }),
        ],
        forceDocument: false,
      });
    } else {
      message = await client.sendFile(process.env.TELEGRAM_CHANNEL_ID, {
        file: uploadedFile,
        caption: filename,
        forceDocument: true,
      });
    }

    // Extract file_id / file_unique_id from the message media
    const media = message.media;
    let fileId, fileUniqueId;

    if (media?.document) {
      fileId       = media.document.id.toString();
      fileUniqueId = media.document.accessHash.toString();
    } else if (media?.photo) {
      const largest = media.photo.sizes[media.photo.sizes.length - 1];
      fileId       = media.photo.id.toString();
      fileUniqueId = media.photo.accessHash.toString();
    } else {
      // Fallback — store message id string as identifier
      fileId       = message.id.toString();
      fileUniqueId = message.id.toString();
    }

    return {
      message_id:      message.id,
      file_id:         fileId,
      file_unique_id:  fileUniqueId,
    };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
};

// ── Stream download a file from Telegram by message_id ───────────────────────
// Called by the /free/..., /api/... and /embed/... express routes.
//
// opts:
//   range     — raw "Range" request header, e.g. "bytes=0-1023". Honored for
//               documents (video/audio/other files) so <video>/<audio> tags
//               can seek/scrub properly and mobile browsers will play at all —
//               most mobile players refuse progressive playback of large
//               files from a server that doesn't support Range.
//   sizeParam — "small" | "medium" | "large" | "original", images only. Maps
//               onto the PhotoSize variants Telegram already generates on
//               upload, so this needs no local image-processing dependency.
//   download  — when true, sets Content-Disposition: attachment so the
//               response is force-downloaded instead of rendered inline.
const streamFileToResponse = async (messageId, res, opts = {}) => {
  const { range, sizeParam, download } = opts;
  const client = await getClient();
  const channelId = process.env.TELEGRAM_CHANNEL_ID;

  const messages = await client.getMessages(channelId, {
    ids: [parseInt(messageId)],
  });

  if (!messages || messages.length === 0 || !messages[0]) {
    throw new Error('Message not found in channel');
  }

  const message = messages[0];
  const media   = message.media;

  if (!media) throw new Error('No media in this message');

  let aborted = false;
  res.on('close', () => { aborted = true; });

  // ── Photos: served whole, at a Telegram-native size variant ──────────────
  // Thumbnails are small (a few KB to ~100KB) so there's no real benefit to
  // range-slicing them — one shot download keeps this path simple.
  if (media.photo) {
    const sizes = (media.photo.sizes || []).filter(
      s => s.className && s.className !== 'PhotoSizeEmpty' && s.className !== 'PhotoStrippedSize'
    );
    let thumb = sizes.length ? sizes[sizes.length - 1] : undefined; // original/largest
    if (sizeParam && sizeParam !== 'original' && sizes.length) {
      const index = {
        small: 0,
        medium: Math.floor((sizes.length - 1) / 2),
        large: sizes.length - 1,
      }[sizeParam];
      if (index !== undefined) thumb = sizes[Math.min(index, sizes.length - 1)];
    }

    const buffer = await client.downloadMedia(media, thumb ? { thumb, workers: 4 } : { workers: 4 });
    if (aborted) return;

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="photo.jpg"`);
    if (buffer) res.setHeader('Content-Length', buffer.length);
    return res.end(buffer);
  }

  // ── Documents: video/audio/generic files, with real Range support ────────
  if (!media.document) throw new Error('Unsupported media type');

  const doc = media.document;
  const fileSize = Number(doc.size);
  const mimeType = doc.mimeType || 'application/octet-stream';
  const nameAttr = doc.attributes?.find(a => a.className === 'DocumentAttributeFilename');
  const fileName = nameAttr ? nameAttr.fileName : 'file';

  let start = 0;
  let end = fileSize > 0 ? fileSize - 1 : undefined;
  let status = 200;

  if (range && fileSize > 0) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      if (match[1]) start = parseInt(match[1], 10);
      if (match[2]) end = parseInt(match[2], 10);
      else end = fileSize - 1;

      if (isNaN(start) || start >= fileSize || start > end) {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.end();
      }
      status = 206;
    }
  }

  res.status(status);
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${fileName}"`);
  if (fileSize) {
    if (status === 206) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', end - start + 1);
    } else {
      res.setHeader('Content-Length', fileSize);
    }
  }

  // Stream in 512KB chunks, honoring the requested range window
  const CHUNK = 512 * 1024;
  let offset = start;
  const target = end !== undefined ? end : Infinity;

  try {
    while (offset <= target && !aborted) {
      const chunkEnd = Math.min(offset + CHUNK - 1, target);
      const chunk = await client.downloadMedia(media, {
        start: offset,
        end: chunkEnd,
        workers: 4,
      });

      if (!chunk || chunk.length === 0) break;
      res.write(chunk);
      offset += chunk.length;
      if (fileSize > 0 && offset > target) break;
    }
  } catch (e) {
    console.error('Stream chunk error:', e.message);
  }

  res.end();
};

// ── Delete a message from the channel ────────────────────────────────────────
const deleteMessage = async (message_id) => {
  try {
    const client = await getClient();
    await client.deleteMessages(process.env.TELEGRAM_CHANNEL_ID, [message_id], { revoke: true });
  } catch (e) {
    console.error('MTProto deleteMessage error:', e.message);
  }
};

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT',  () => { if (_client) _client.disconnect(); process.exit(0); });
process.on('SIGTERM', () => { if (_client) _client.disconnect(); process.exit(0); });

module.exports = { uploadFile, deleteMessage, streamFileToResponse, getClient };
