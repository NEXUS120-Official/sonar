// ============================================================
// SONAR — Signal Engine
// ============================================================
// Named barrel for the flow-engine computation modules.
// Product code and future sovereign intelligence layers import
// from here, not directly from flow-engine/*.
//
// Modules:
//   aggregator          — FlowMetrics computation from movements
//   bias-index          — Bias Index score (-100 to +100)
//   anomaly-detector    — spike / reversal detection
//   confluence          — multi-signal confluence scoring
//   cohort-analysis     — whale cohort grouping
//   cohort-attribution  — per-alert cohort context for alert enrichment
//   dedup               — movement deduplication
// ============================================================

export * from '@/lib/flow-engine/aggregator';
export * from '@/lib/flow-engine/bias-index';
export * from '@/lib/flow-engine/anomaly-detector';
export * from '@/lib/flow-engine/confluence';
export * from '@/lib/flow-engine/cohort-analysis';
export * from '@/lib/flow-engine/cohort-attribution';
export * from '@/lib/flow-engine/dedup';
