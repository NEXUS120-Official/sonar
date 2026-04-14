// ============================================================
// SONAR v2.0 — AI Alert Writer
// ============================================================
// Enriches alert body with a short Claude-generated analysis.
// Keeps it factual — no hype, no price predictions.
//
// Fails safe: if Anthropic is unavailable or rate-limited,
// returns a deterministic template fallback. The alert is
// always written to DB regardless.
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import { checkRateLimit, RateLimiters } from '@/lib/utils/rate-limiter';
import type { AlertType } from '@/lib/supabase/types';

// ── Types ─────────────────────────────────────────────────────

export interface AlertContext {
  alert_type:    AlertType;
  title:         string;
  body:          string;
  metrics: {
    net_exchange_flow_usd?:  number;
    net_staking_flow_usd?:   number;
    net_defi_flow_usd?:      number;
    net_usdc_flow_usd?:      number;
    bias_score?:             number;
    market_bias?:            string;
    large_movements_count?:  number;
    unique_whales_active?:   number;
    [key: string]: number | string | undefined;
  };
  window_hours?: number;
}

// ── Deterministic fallbacks ───────────────────────────────────

function fallbackAnalysis(ctx: AlertContext): string {
  const { alert_type, metrics } = ctx;

  switch (alert_type) {
    case 'exchange_spike':
      return 'Exchange volume is significantly above recent averages. Monitor closely for follow-through in price action.';

    case 'accumulation_wave': {
      const net = metrics.net_exchange_flow_usd;
      const amt = net !== undefined ? `${Math.abs(net / 1e6).toFixed(1)}M USD` : 'significant capital';
      return `${amt} moved off exchanges. Historically, sustained exchange outflows precede price appreciation as supply tightens.`;
    }

    case 'distribution_wave': {
      const net = metrics.net_exchange_flow_usd;
      const amt = net !== undefined ? `${Math.abs(net / 1e6).toFixed(1)}M USD` : 'significant capital';
      return `${amt} moved to exchanges. Elevated exchange inflows increase near-term sell pressure.`;
    }

    case 'staking_shift': {
      const net = metrics.net_staking_flow_usd ?? 0;
      return net > 0
        ? 'Capital locking into staking reduces liquid supply. Positive long-term signal if sustained.'
        : 'Unstaking events increase liquid supply. Watch for near-term selling pressure.';
    }

    case 'stablecoin_flow':
      return metrics.net_usdc_flow_usd && metrics.net_usdc_flow_usd > 0
        ? 'Stablecoin inflows signal capital ready to deploy. Historically bullish for near-term price action.'
        : 'Stablecoin outflows suggest capital rotation out of the ecosystem.';

    case 'whale_large_move':
      return 'Large whale movement detected. Direction relative to exchanges will determine directional bias.';

    case 'defi_rotation':
      return 'Capital rotating within DeFi protocols. Net direction indicates risk-on or risk-off positioning.';

    case 'weekly_report':
      return 'Weekly smart money flow summary. Review the full breakdown for directional conviction.';

    default:
      return 'Smart money flow detected. Review the metrics for directional context.';
  }
}

// ── Claude-based enrichment ───────────────────────────────────

const SYSTEM_PROMPT = `You are a concise, factual analyst for a Solana smart money flow tracker.
Write a 1-2 sentence interpretation of the provided on-chain flow data.
Rules:
- No price predictions
- No hype ("massive", "exploding", "moon")
- Factual and neutral tone
- Reference specific numbers from the data
- Focus on what the capital movement implies about large holder behavior`;

function buildUserPrompt(ctx: AlertContext): string {
  const lines = [
    `Alert type: ${ctx.alert_type}`,
    `Window: ${ctx.window_hours ?? 24}h`,
    `Summary: ${ctx.body}`,
    '',
    'Key metrics:',
    ...Object.entries(ctx.metrics)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `  ${k}: ${typeof v === 'number' ? v.toFixed(2) : v}`),
  ];
  return lines.join('\n');
}

/**
 * Generate a short AI analysis for an alert.
 * Returns fallback text if Anthropic is unavailable.
 */
export async function generateAlertAnalysis(ctx: AlertContext): Promise<string> {
  const ts = new Date().toISOString();

  // Check rate limit before calling Anthropic
  if (!checkRateLimit('anthropic', RateLimiters.anthropic)) {
    console.warn(`[ai/alert-writer][${ts}] Rate limited — using fallback`);
    return fallbackAnalysis(ctx);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(`[ai/alert-writer][${ts}] No ANTHROPIC_API_KEY — using fallback`);
    return fallbackAnalysis(ctx);
  }

  try {
    console.log(`[ai/alert-writer][${ts}] Generating analysis for ${ctx.alert_type}`);
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',  // fastest + cheapest
      max_tokens: 150,
      system:     SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: buildUserPrompt(ctx) },
      ],
    });

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join(' ')
      .trim();

    if (!text) {
      console.warn(`[ai/alert-writer][${ts}] Empty response — using fallback`);
      return fallbackAnalysis(ctx);
    }

    console.log(`[ai/alert-writer][${ts}] Analysis generated (${text.length} chars)`);
    return text;
  } catch (err) {
    console.error(`[ai/alert-writer][${ts}] Anthropic error — using fallback`, err);
    return fallbackAnalysis(ctx);
  }
}
