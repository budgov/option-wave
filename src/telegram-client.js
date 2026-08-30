import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { NewMessage, EditedMessage } from "teleproto/events/index.js";
import { loadTelegramSecrets, saveTelegramSecrets } from "./secrets.js";

function promptInterface() {
  return readline.createInterface({ input, output });
}

async function askNonEmpty(rl, label) {
  while (true) {
    const value = (await rl.question(label)).trim();
    if (value) return value;
  }
}

export async function interactiveLogin(root) {
  const rl = promptInterface();
  try {
    const apiId = Number(process.env.TELEGRAM_API_ID || await askNonEmpty(rl, "Telegram API ID: "));
    const apiHash = process.env.TELEGRAM_API_HASH || await askNonEmpty(rl, "Telegram API Hash: ");
    const phone = await askNonEmpty(rl, "Telegram phone number (international format): ");
    const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
      connectionRetries: 5,
      autoReconnect: true
    });
    await client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => askNonEmpty(rl, "Telegram login code: "),
      password: async () => askNonEmpty(rl, "Telegram 2FA password: "),
      onError: (error) => console.error(`Telegram login error: ${error.message}`)
    });
    const session = client.session.save();
    saveTelegramSecrets(root, { apiId, apiHash, session });
    await client.disconnect();
    console.log("Telegram session saved with Windows DPAPI for the current Windows user.");
  } finally {
    rl.close();
  }
}

export async function connectTelegram(root) {
  const { apiId, apiHash, session } = loadTelegramSecrets(root);
  const client = new TelegramClient(new StringSession(session), Number(apiId), apiHash, {
    connectionRetries: 5,
    autoReconnect: true
  });
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error("Telegram authorization expired; run telegram-login again.");
  return client;
}

function normalizeTitle(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase();
}

function telegramObjectId(value) {
  const id = value?.id;
  return id == null ? null : String(id);
}

export async function resolveTargetChannels(client, targets) {
  const dialogs = await client.getDialogs({ limit: 500 });
  const resolved = [];
  for (const target of targets) {
    const matches = dialogs.filter((dialog) => normalizeTitle(dialog.name) === normalizeTitle(target.title));
    if (matches.length === 0) throw new Error(`Telegram dialog not found: ${target.title}`);
    if (matches.length > 1) {
      throw new Error(`Telegram dialog title is ambiguous: ${target.title}. Add an exact id/username to config.`);
    }
    const dialog = matches[0];
    resolved.push({
      ...target,
      entity: dialog.entity,
      chatId: String(dialog.id),
      displayName: dialog.name
    });
  }
  return resolved;
}

export function messageRecord(channel, message, edited = false) {
  const publishedAt = message.date instanceof Date ? message.date.toISOString() : new Date(message.date * 1000).toISOString();
  const editDate = message.editDate instanceof Date
    ? message.editDate.toISOString()
    : message.editDate ? new Date(message.editDate * 1000).toISOString() : null;
  return {
    channelKey: channel.key,
    chatId: channel.chatId,
    messageId: String(message.id),
    publishedAt,
    eventAt: edited ? (editDate ?? new Date().toISOString()) : publishedAt,
    receivedAt: new Date().toISOString(),
    editedAt: edited ? (editDate ?? new Date().toISOString()) : editDate,
    replyToMessageId: message.replyTo?.replyToMsgId ?? null,
    rawText: message.message ?? "",
    raw: {
      id: String(message.id),
      chat_id: channel.chatId,
      channel_title: channel.displayName,
      date: publishedAt,
      edit_date: editDate,
      event_at: edited ? (editDate ?? null) : publishedAt,
      grouped_id: message.groupedId == null ? null : String(message.groupedId),
      has_media: Boolean(message.media),
      media_id: telegramObjectId(message.media?.photo ?? message.media?.document),
      media_kind: message.media ? String(message.media.className ?? message.media.constructor?.name ?? "unknown") : null,
      media_mime_type: message.media?.document?.mimeType ?? null,
      is_edit: edited
    }
  };
}

function idText(value) {
  return value == null ? "" : String(value);
}

function channelIds(channel) {
  const chatId = idText(channel.chatId);
  return new Set([
    chatId,
    chatId.replace(/^-100/, ""),
    idText(channel.entity?.id),
    idText(channel.entity?.channelId)
  ].filter(Boolean));
}

export async function latestMessageId(client, channel) {
  const messages = await client.getMessages(channel.entity, { limit: 1 });
  return messages[0]?.id == null ? 0 : Number(messages[0].id);
}

export async function messagesAfter(client, channel, minId, limit = 100) {
  const messages = await client.getMessages(channel.entity, {
    limit: Math.max(1, Number(limit)),
    minId: Math.max(0, Number(minId) || 0),
    reverse: true
  });
  return messages
    .filter((message) => Number(message.id) > Number(minId))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

export async function subscribeMessages(client, channels, onMessage, onError = console.error) {
  const byId = new Map();
  for (const channel of channels) {
    for (const id of channelIds(channel)) byId.set(id, channel);
  }
  const lookup = (message) => {
    const id = idText(message.peerId?.channelId ?? message.peerId?.chatId ?? message.peerId?.userId ?? message.chatId);
    return byId.get(id) ?? channels.find((channel) => id && channelIds(channel).has(id));
  };
  const handle = (edited) => async (event) => {
    try {
      const channel = lookup(event.message);
      if (!channel) return;
      onMessage(messageRecord(channel, event.message, edited), event.message, edited ? "edit_event" : "new_event");
    } catch (error) {
      try {
        await onError(error);
      } catch (reportError) {
        console.error(`Telegram event error handler failed: ${reportError.message}`);
      }
    }
  };
  // Passing teleproto Channel objects through `chats` stringifies them to
  // "[object Object]". Resolve empty builders now and apply the peer allowlist
  // above in the callback so a broken builder fails during startup.
  const newBuilder = new NewMessage({});
  const editBuilder = new EditedMessage({});
  await newBuilder.resolve(client);
  await editBuilder.resolve(client);
  const newHandler = handle(false);
  const editHandler = handle(true);
  client.addEventHandler(newHandler, newBuilder);
  client.addEventHandler(editHandler, editBuilder);
  return () => {
    client.removeEventHandler(newHandler, newBuilder);
    client.removeEventHandler(editHandler, editBuilder);
  };
}
