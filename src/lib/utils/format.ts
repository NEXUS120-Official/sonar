// ============================================================
// SONAR — Formatting Utilities
// ============================================================

/**
 * Format a USD amount with appropriate suffix (K, M, B).
 * e.g. 1500000 → "$1.5M"
 */
export function formatUsd(amount: number, compact = true): string {
  if (!isFinite(amount)) return '$0';
  if (!compact || Math.abs(amount) < 1000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    }).format(amount);
  }
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Format a token amount (large numbers with commas, small with decimals).
 */
export function formatTokenAmount(amount: number, symbol?: string): string {
  if (!isFinite(amount)) return '0';
  const formatted =
    amount >= 1
      ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount)
      : amount.toFixed(6).replace(/\.?0+$/, '');
  return symbol ? `${formatted} ${symbol}` : formatted;
}

/**
 * Truncate a wallet/token address for display.
 * e.g. "So11111111..." → "So11...1112"
 */
export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Format a percentage value.
 * e.g. 72.5 → "72.5%"
 */
export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/**
 * Format a win rate as percentage with color context.
 */
export function formatWinRate(winRate: number | null): string {
  if (winRate === null) return 'N/A';
  return formatPercent(winRate);
}

/**
 * Format hours into a human-readable duration string.
 * e.g. 2.5 → "2h 30m", 26 → "1 day 2h"
 */
export function formatHours(hours: number): string {
  if (!isFinite(hours) || hours < 0) return 'Unknown';
  const days = Math.floor(hours / 24);
  const remainingHours = Math.floor(hours % 24);
  const minutes = Math.round((hours % 1) * 60);

  if (days > 0 && remainingHours > 0) return `${days}d ${remainingHours}h`;
  if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
  if (remainingHours > 0 && minutes > 0) return `${remainingHours}h ${minutes}m`;
  if (remainingHours > 0) return `${remainingHours}h`;
  return `${minutes}m`;
}

/**
 * Format token age from hours to display string.
 * e.g. 48 → "2 days", 1.5 → "1h 30m"
 */
export function formatTokenAge(ageHours: number): string {
  return formatHours(ageHours);
}

/**
 * Format a timestamp to relative time (e.g. "3 minutes ago").
 */
export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

/**
 * Format a market cap value for display.
 */
export function formatMarketCap(mcap: number): string {
  return formatUsd(mcap, true);
}

/**
 * Parse and normalize a token symbol for display (uppercase, strip $).
 */
export function normalizeSymbol(symbol: string): string {
  return symbol.replace(/^\$/, '').toUpperCase();
}

/**
 * Clamp a number between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
