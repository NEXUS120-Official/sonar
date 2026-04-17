-- ============================================================
-- SONAR Migration 011 — Cluster member supporting metrics
-- ============================================================
-- Adds metadata JSONB to wallet_cluster_members so each
-- membership row stores the per-wallet supporting evidence
-- used to assign it to a behavioral cluster.
--
-- Payload written by buildBehaviorClusters (behavior_v1):
--   methodology_version, assigned_cluster_type, window_days,
--   total_movements, exchange_deposit_count,
--   exchange_withdrawal_count, stake_count,
--   defi_deposit_count, defi_withdrawal_count,
--   total_value_usd, staked_total, generated_at
--
-- Safe to run multiple times (IF NOT EXISTS / idempotent).
-- Existing rows receive NULL for this column — no data loss.
-- ============================================================

ALTER TABLE wallet_cluster_members
  ADD COLUMN IF NOT EXISTS metadata JSONB;
