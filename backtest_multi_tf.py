import pandas as pd, numpy as np, json
from pathlib import Path

snapshots_path = Path.home() / "sonar" / "backups" / "flow_snapshots.json"
with open(snapshots_path) as f:
    snapshots = json.load(f)
df = pd.DataFrame(snapshots)
df['snapshot_time'] = pd.to_datetime(df['snapshot_time'], format='ISO8601')
df['date'] = df['snapshot_time'].dt.date

prices_path = Path.home() / "sonar" / "data" / "SOLUSDT_1day.csv"
df_prices = pd.read_csv(prices_path)
df_prices['timestamp'] = pd.to_datetime(df_prices['timestamp'], format='ISO8601')
df_prices['date'] = df_prices['timestamp'].dt.date

def backtest(window_hours, label, threshold=20):
    snap = df[df['window_hours'] == window_hours].groupby('date').agg(
        bias_score=('bias_score', 'last')
    ).reset_index()
    merged = df_prices.merge(snap, on='date', how='left').dropna(subset=['bias_score'])
    merged['position'] = 0
    merged.loc[merged['bias_score'] > threshold, 'position'] = 1
    merged.loc[merged['bias_score'] < -threshold, 'position'] = -1
    merged['returns'] = merged['close'].pct_change()
    merged['strategy_returns'] = merged['position'].shift(1) * merged['returns']
    sr = merged['strategy_returns'].dropna()
    if len(sr) == 0:
        return {'Label': label, 'Days': 0, 'Signals': 0}
    cum = (1 + sr).cumprod()
    tot = cum.iloc[-1] - 1
    ann_ret = (1 + tot) ** (365 / len(sr)) - 1
    vol = sr.std() * np.sqrt(365)
    sharpe = ann_ret / vol if vol > 0 else 0
    mdd = ((cum - cum.cummax()) / cum.cummax()).min()
    wins = sr[sr > 0]
    losses = sr[sr < 0]
    wr = len(wins) / len(sr) if len(sr) > 0 else 0
    pf = abs(wins.sum() / losses.sum()) if losses.sum() != 0 else float('inf')
    return {
        'Label': label, 'Days': len(sr), 'Signals': int(merged['position'].abs().sum()),
        'Total Return': f"{tot:.2%}", 'Ann. Return': f"{ann_ret:.2%}",
        'Sharpe': f"{sharpe:.2f}", 'Max DD': f"{mdd:.2%}",
        'Win Rate': f"{wr:.2%}", 'Profit Factor': f"{pf:.2f}"
    }

results = [
    backtest(24, 'Daily (24h)'),
    backtest(4, '4-Hour'),
    backtest(1, '1-Hour'),
]

print("\n=== Backtest Multi-Timeframe ===\n")
print(f"{'Timeframe':<14} {'Days':<6} {'Signals':<8} {'Return':<10} {'Sharpe':<8} {'Max DD':<9} {'Win Rate':<9} {'PF':<6}")
print("-" * 75)
for r in results:
    print(f"{r['Label']:<14} {r['Days']:<6} {r['Signals']:<8} {r['Total Return']:<10} {r['Sharpe']:<8} {r['Max DD']:<9} {r['Win Rate']:<9} {r['Profit Factor']:<6}")
