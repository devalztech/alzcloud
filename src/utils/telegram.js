/**
 * AlzCloud — MTProto File Storage
 * Uses GramJS (Telegram user client) for 2GB upload/download limit.
 * Credentials: Alz cloud app (api_id: 27586230)
 */

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const { CustomFile } = require('telegram/client/uploads');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ── MTProto credentials (from my.telegram.org/apps) ──────────────────────────
const API_ID   = 27586230;
const API_HASH = '638e699ca88b5280146a55e959f1fde9';

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

// ── Get a download URL for a stored file ─────────────────────────────────────
// MTProto doesn't give direct URLs like the Bot API does.
// We route downloads through our own /dl/:slug endpoint which streams via GramJS.
// file_id stored in DB is the message_id (as string) for MTProto files.
const getFileUrl = async (file_id) => {
  // Return a relative download URL — our express route handles streaming
  return `/dl/${file_id}`;
};

// ── Stream download a file from Telegram by message_id ───────────────────────
// Called by the new /dl/:messageId express route
const streamFileToResponse = async (messageId, res) => {
  const client = await getClient();
  const channelId = process.env.TELEGRAM_CHANNEL_ID;

  // Fetch the message to get media
  const messages = await client.getMessages(channelId, {
    ids: [parseInt(messageId)],
  });

  if (!messages || messages.length === 0 || !messages[0]) {
    throw new Error('Message not found in channel');
  }

  const message = messages[0];
  const media   = message.media;

  if (!media) throw new Error('No media in this message');

  // Get file size for Content-Length header
  let fileSize = 0;
  let fileName = 'file';
  let mimeType = 'application/octet-stream';

  if (media.document) {
    fileSize = Number(media.document.size);
    mimeType = media.document.mimeType || mimeType;
    const nameAttr = media.document.attributes?.find(a => a.className === 'DocumentAttributeFilename');
    if (nameAttr) fileName = nameAttr.fileName;
  } else if (media.photo) {
    mimeType = 'image/jpeg';
    fileName = 'photo.jpg';
  }

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  if (fileSize) res.setHeader('Content-Length', fileSize);

  // Stream in 512KB chunks
  const CHUNK = 512 * 1024;
  let offset = 0;

  while (true) {
    const chunk = await client.downloadMedia(media, {
      start: offset,
      end: Math.min(offset + CHUNK - 1, fileSize > 0 ? fileSize - 1 : Infinity),
      workers: 4,
    });

    if (!chunk || chunk.length === 0) break;
    res.write(chunk);
    offset += chunk.length;
    if (fileSize > 0 && offset >= fileSize) break;
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

module.exports = { uploadFile, getFileUrl, deleteMessage, streamFileToResponse, getClient };
