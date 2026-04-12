// ============================================================
// SONAR — Telegram Incoming Webhook
// POST /api/webhook/telegram
// ============================================================
// Receives updates from Telegram (commands from users/channel).
// Register this URL with Telegram using:
//   GET https://api.telegram.org/bot{TOKEN}/setWebhook?url={APP_URL}/api/webhook/telegram
//   or run: npm run setup:telegram-webhook
//
// Verifies the secret token header set during webhook registration.
// Returns 200 always to prevent Telegram retry storms.

import { type NextRequest, NextResponse } from 'next/server';
import { sendToChat } from '@/lib/telegram/bot';
import {
  handleStart,
  handleConsensus,
  handleWhale,
  handleSafety,
  handleTop,
  handleSubmit,
} from '@/lib/telegram/commands';

// ── Types ─────────────────────────────────────────────────────

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    username?: string;
    first_name?: string;
  };
  chat: {
    id: number;
    type: string;
  };
  text?: string;
  date: number;
}

// ── Auth ──────────────────────────────────────────────────────

function verifyTelegramSecret(req: NextRequest): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return true;   // not configured → allow in dev
  const header = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  return header === secret;
}

// ── Dispatcher ────────────────────────────────────────────────

async function dispatch(msg: TelegramMessage): Promise<void> {
  const text   = msg.text?.trim() ?? '';
  const chatId = String(msg.chat.id);
  const from   = msg.from;

  if (!text.startsWith('/')) return;

  // Parse command and args: "/command arg1 arg2"
  const [rawCommand, ...args] = text.split(/\s+/);
  // Strip bot username suffix if present: /start@SonarBot → /start
  const command = (rawCommand.split('@')[0] ?? '').toLowerCase();
  const arg0    = args[0] ?? '';

  let response: string;

  switch (command) {
    case '/start':
      response = handleStart();
      break;
    case '/consensus':
      response = await handleConsensus();
      break;
    case '/whale':
      response = await handleWhale(arg0);
      break;
    case '/safety':
      response = await handleSafety(arg0);
      break;
    case '/top':
      response = await handleTop();
      break;
    case '/submit':
      response = await handleSubmit(arg0, {
        chatId,
        username: from?.username,
        messageId: msg.message_id,
      });
      break;
    default:
      return;   // unknown command — silently ignore
  }

  if (response) {
    await sendToChat(chatId, response);
  }
}

// ── Route handler ─────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Always return 200 — Telegram retries if it gets non-200
  if (!verifyTelegramSecret(req)) {
    console.warn('[webhook/telegram] Invalid secret token');
    return NextResponse.json({ ok: true });
  }

  let update: TelegramUpdate;
  try {
    update = await req.json() as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const msg = update.message ?? update.channel_post;
  if (msg) {
    // Await dispatch — Vercel serverless kills unawaited work after response is sent
    await dispatch(msg).catch((err) =>
      console.error('[webhook/telegram] Dispatch error:', err),
    );
  }

  return NextResponse.json({ ok: true });
}
