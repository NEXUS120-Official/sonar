import pandas as pd
import numpy as np
import json
from pathlib import Path

snapshots_path = Path.home() / "sonar" / "backups" / "flow_snapshots.json"
with open(snapshots_path, 'r') as f:
    snapshots = json.load(f)
df_sonar = pd.DataFrame(snapshots)
df_sonar['snapshot_time'] = pd.to_datetime(df_sonar['snapshot_time'], format='ISO8601')
df_sonar = df_sonar.sort_values('snapshot_time')

prices_path = Path.home() / "sonar" / "data" / "SOLUSDT_1day.csv"
df_prices = pd.read_csv(prices_path)
df_prices['timestamp'] = pd.to_datetime(df_prices['timestamp'], format='ISO8601')
df_prices = df_prices.sort_values('timestamp')

df_prices['volume_ma20'] = df_prices['volume'].rolling(20).mean()
df_prices['volume_ratio'] = df_prices['volume'] / df_prices['volume_ma20']

df_sonar['date'] = df_sonar['snapshot_time'].dt.date
df_sonar_daily = df_sonar.groupby('date').agg({
    'bias_score': 'last',
    'sol_net_exchange_flow_usd': 'last',
    'net_staking_flow_usd': 'last',
    'net_defi_flow_usd': 'last'
}).reset_index()

df_prices['date'] = df_prices['timestamp'].dt.date
df_merged = pd.merge(df_prices, df_sonar_daily, on='date', how='left')
df_merged = df_merged.dropna(subset=['bias_score'])

def calc_metrics(sr, name, n_signals):
    sr = sr.dropna()
    if len(sr) == 0:
        return {f'{name} Win Rate': '0%', f'{name} Profit Factor': '0', f'{name} Signals': n_signals}
    cum = (1 + sr).cumprod()
    tot_ret = cum.iloc[-1] - 1
    ann_ret = (1 + tot_ret) ** (365 / len(sr)) - 1 if len(sr) > 0 else 0
    ann_vol = sr.std() * np.sqrt(365)
    sharpe = ann_ret / ann_vol if ann_vol > 0 else 0
    dd = (cum - cum.cummax()) / cum.cummax()
    max_dd = dd.min()
    wins = sr[sr > 0]
    losses = sr[sr < 0]
    wr = len(wins) / len(sr) if len(sr) > 0 else 0
    pf = abs(wins.sum() / losses.sum()) if losses.sum() != 0 else float('inf')
    return {
        f'{name} Total Return': f"{tot_ret:.2%}",
        f'{name} Sharpe': f"{sharpe:.2f}",
        f'{name} Max DD': f"{max_dd:.2%}",
        f'{name} Win Rate': f"{wr:.2%}",
        f'{name} Profit Factor': f"{pf:.2f}",
        f'{name} Signals': n_signals,
    }

# V1: strategia base (Bias > 20 / Bias < -20)
df_v1 = df_merged.copy()
df_v1['position'] = 0
df_v1.loc[df_v1['bias_score'] > 20, 'position'] = 1
df_v1.loc[df_v1['bias_score'] < -20, 'position'] = -1
df_v1['returns'] = df_v1['close'].pct_change()
df_v1['strategy_returns'] = df_v1['position'].shift(1) * df_v1['returns']
m1 = calc_metrics(df_v1['strategy_returns'], 'V1-Base', int(df_v1['position'].abs().sum()))

# V2: Bias + componenti allineati (senza volume, senza EMA)
df_v2 = df_merged.copy()
df_v2['bullish_components'] = ((df_v2['sol_net_exchange_flow_usd']<0).astype(int) + (df_v2['net_staking_flow_usd']>0).astype(int) + (df_v2['net_defi_flow_usd']>0).astype(int))
df_v2['bearish_components'] = ((df_v2['sol_net_exchange_flow_usd']>0).astype(int) + (df_v2['net_staking_flow_usd']<0).astype(int) + (df_v2['net_defi_flow_usd']<0).astype(int))
df_v2['position'] = 0
df_v2.loc[(df_v2['bias_score'] > 20) & (df_v2['bullish_components'] >= 2), 'position'] = 1
df_v2.loc[(df_v2['bias_score'] < -20) & (df_v2['bearish_components'] >= 2), 'position'] = -1
df_v2['returns'] = df_v2['close'].pct_change()
df_v2['strategy_returns'] = df_v2['position'].shift(1) * df_v2['returns']
m2 = calc_metrics(df_v2['strategy_returns'], 'V2-Components', int(df_v2['position'].abs().sum()))

# V3: Bias + componenti + volume
df_v3 = df_merged.copy()
df_v3['bullish_components'] = ((df_v3['sol_net_exchange_flow_usd']<0).astype(int) + (df_v3['net_staking_flow_usd']>0).astype(int) + (df_v3['net_defi_flow_usd']>0).astype(int))
df_v3['bearish_components'] = ((df_v3['sol_net_exchange_flow_usd']>0).astype(int) + (df_v3['net_staking_flow_usd']<0).astype(int) + (df_v3['net_defi_flow_usd']<0).astype(int))
df_v3['position'] = 0
df_v3.loc[(df_v3['bias_score'] > 20) & (df_v3['bullish_components'] >= 2) & (df_v3['volume_ratio'] > 1.0), 'position'] = 1
df_v3.loc[(df_v3['bias_score'] < -20) & (df_v3['bearish_components'] >= 2) & (df_v3['volume_ratio'] > 1.0), 'position'] = -1
df_v3['returns'] = df_v3['close'].pct_change()
df_v3['strategy_returns'] = df_v3['position'].shift(1) * df_v3['returns']
m3 = calc_metrics(df_v3['strategy_returns'], 'V3-Vol', int(df_v3['position'].abs().sum()))

# Output comparativo
print("=== SONAR Backtest — Confronto Strategie ===\n")
print(f"{'Metric':<22} {'V1 (Base)':<16} {'V2 (+Comp)':<16} {'V3 (+Vol)':<16}")
print("-" * 70)
keys = ['Total Return', 'Sharpe', 'Max DD', 'Win Rate', 'Profit Factor', 'Signals']
for k in keys:
    v1 = m1.get(f'V1-Base {k}', 'N/A')
    v2 = m2.get(f'V2-Components {k}', 'N/A')
    v3 = m3.get(f'V3-Vol {k}', 'N/A')
    print(f"{k:<22} {str(v1):<16} {str(v2):<16} {str(v3):<16}")
