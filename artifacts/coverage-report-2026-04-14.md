# SONAR Address Coverage Report
**Generated:** 2026-04-14
**Sprint:** Address Coverage + Public Signal Sprint

---

## Summary

| Category  | Before | After | Delta |
|-----------|--------|-------|-------|
| Exchange  | 16     | 16    | +0    |
| Staking   | 5      | 5     | +0    |
| DeFi      | 6      | 9     | +3    |
| Bridge    | 0      | 2     | +2    |
| **Total** | **27** | **32**| **+5**|

Webhook budget: **82 / 150** used (55%)

---

## Exchange (16 addresses)

| Label                  | Sub-category | Verification |
|------------------------|--------------|-------------|
| Binance Hot Wallet 1   | binance      | Solscan label "Binance 2" |
| Binance Hot Wallet 2   | binance      | Solscan label "Binance 3" |
| Binance.US Hot Wallet  | binance_us   | Solscan label |
| Coinbase Hot Wallet 2  | coinbase     | Solscan label "Coinbase Hot Wallet 2" |
| Coinbase Hot Wallet 3  | coinbase     | Solscan label "Coinbase Hot Wallet 3" |
| OKX Hot Wallet 1       | okx          | Solscan label "OKX: Hot Wallet" |
| OKX Hot Wallet 2       | okx          | Solscan label |
| OKX Hot Wallet 3       | okx          | Solscan label |
| KuCoin Hot Wallet      | kucoin       | Solscan label "Kucoin" |
| Gate.io Hot Wallet     | gate         | Solscan label "Gate.io" |
| HTX Hot Wallet         | htx          | Solscan label "HTX: Hot Wallet" |
| MEXC Hot Wallet        | mexc         | Solscan label "MEXC" |
| Kraken Hot Wallet      | kraken       | Single verified wallet |
| Bybit Hot Wallet 1     | bybit        | Unverified on Solscan — retained for coverage |
| Bybit Hot Wallet 2     | bybit        | Solscan label "Bybit Hot Wallet" |

**Exchange gaps (action required before adding):**
- Crypto.com: high volume on Solana, address not yet verified
- Upbit / Bithumb: Korean exchanges, significant SOL volume, unverified
- Robinhood Crypto: US retail, active SOL withdrawals, unverified
- Phemex / WOO Network: not verified
- Binance additional hot wallets: exchanges rotate wallets; re-verify against Solscan periodically

**Methodology for safe exchange address addition:**
1. Search Solscan for exchange label on high-volume addresses
2. Confirm via Helius signature pattern (high-frequency SOL transfers)
3. Cross-check against community trackers (Nansen, Arkham) where available
4. Never add without at least one confirmed public label

---

## Staking Protocols (5 addresses)

| Label                  | Sub-category | Source |
|------------------------|--------------|--------|
| Marinade Staking       | marinade     | docs.marinade.finance/developers/contract-addresses |
| Jito Staking           | jito         | Jito documentation |
| BlazeStake Pool (bSOL) | blazestake   | solanacompass.com/stake-pools |
| Sanctum Router         | sanctum      | solanafm deep-dive |
| Sanctum Unstake        | sanctum      | solanafm deep-dive |

**Staking gaps:**
- Native Solana stake program (`Stake11111111111111111111111111111111111111112`): program address, not a receiving wallet — not trackable via transfer events in the current flow model
- Lido on Solana: **discontinued November 2023** — intentionally excluded (dead protocol = noise)
- JPool: address not verified; low TVL — low priority
- Cogent SOL: low TVL — low priority

---

## DeFi Protocols (9 addresses) — 3 added this sprint

| Label                  | Sub-category | Added  | Source |
|------------------------|--------------|--------|--------|
| Raydium AMM            | raydium      | Prior  | Raydium documentation |
| **Raydium CLMM**       | raydium      | NEW    | raydium.io/clmm docs |
| Orca Whirlpool         | orca         | Prior  | Orca documentation |
| Jupiter Vote           | jupiter      | Prior  | Jupiter governance |
| **Jupiter v6 Aggregator** | jupiter   | NEW    | jup.ag aggregator program |
| Marginfi Lending       | marginfi     | Prior  | Marginfi documentation |
| Drift Protocol         | drift        | Prior  | Drift documentation |
| Kamino Finance         | kamino       | Prior  | Kamino documentation |
| **Solend Main Pool**   | solend       | NEW    | solend.fi/docs |

**DeFi gaps:**
- Mango Markets v4: program address not confirmed with high confidence — hold pending verification
- Phoenix DEX: program address not confirmed — hold
- Zeta Markets: derivatives, program not confirmed — hold
- Tulip Protocol: low TVL — low priority

---

## Bridge Protocols (2 addresses) — 2 added this sprint

| Label                   | Sub-category | Source |
|-------------------------|--------------|--------|
| Wormhole Token Bridge   | wormhole     | Wormhole Foundation CONTRACTS.md |
| Wormhole Core Bridge    | wormhole     | Wormhole Foundation CONTRACTS.md |

**Note:** Bridge flows are classified as `bridge_in` / `bridge_out` in the movements table
and counted in `large_movements_count` but excluded from bias score components.
They provide signal for cross-chain capital movement analysis only.

**Bridge gaps:**
- Allbridge: address not verified with high confidence — hold
- deBridge: address not confirmed — hold
- Mayan Finance: not confirmed — hold

---

## Webhook Budget

```
16 exchange  + 5 staking + 9 defi + 2 bridge + 50 whales = 82 addresses
Configured max per category:
  exchange: 20, staking: 10, defi: 15, bridge: 5, whales: 50
Total budget: 150
Remaining: 68 slots (45%)
```

---

## Recommended Next Actions

### High priority (verify then add)
1. **Crypto.com Solana hot wallet** — confirm via Solscan search for high-volume SOL transfers labeled "Crypto.com"
2. **Bybit Hot Wallet 1** — currently unverified; confirm or remove
3. **Binance additional wallets** — Binance rotates wallets; monitor Solscan for new "Binance" labels

### Medium priority
4. **Upbit** — Korean exchange with high SOL volume; requires Solscan label confirmation
5. **Mango Markets v4** — verify program ID against Mango GitHub before adding

### Low priority
6. **Phoenix DEX**, **Zeta Markets** — verify program IDs when time permits

### Maintenance
- Review exchange addresses quarterly for wallet rotation
- Re-run this report after any address addition to keep coverage accounting accurate
