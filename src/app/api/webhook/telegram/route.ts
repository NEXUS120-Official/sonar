// ============================================================
// SONAR v2.0 — Telegram Incoming Webhook
// POST /api/webhook/telegram
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { sendToChat } from '@/lib/telegram/bot';
import {
  handleStart,
  handleFlow,
  handleExchanges,
  handleStaking,
  handleWhale,
  handleReport,
  handlePro,
} from '@/lib/telegram/commands';

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string };
  text?: string;
  date: number;
}

function verifyTelegramSecret(req: NextRequest): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return true;
  const header = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  return header === secret;
}

async function dispatch(msg: TelegramMessage): Promise<void> {
  const text   = msg.text?.trim() ?? '';
  const chatId = String(msg.chat.id);

  if (!text.startsWith('/')) return;

  const [rawCommand, ...args] = text.split(/\s+/);
  const command = (rawCommand?.split('@')[0] ?? '').toLowerCase();
  const arg0    = args[0] ?? '';

  let response: string;

  switch (command) {
    case '/start':     response = handleStart();                    break;
    case '/flow':      response = await handleFlow();               break;
    case '/exchanges': response = await handleExchanges();          break;
    case '/staking':   response = await handleStaking();            break;
    case '/whale':     response = await handleWhale(arg0);          break;
    case '/report':    response = await handleReport();             break;
    case '/pro':       response = handlePro();                      break;
    default:           return;
  }

  if (response) await sendToChat(chatId, response);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
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
    await dispatch(msg).catch((err) =>
      console.error('[webhook/telegram] Dispatch error:', err),
    );
  }

  return NextResponse.json({ ok: true });
}
