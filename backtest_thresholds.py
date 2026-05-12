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

snap = df[df['window_hours'] == 24].groupby('date').agg(
    bias_score=('bias_score', 'last')
).reset_index()
merged = df_prices.merge(snap, on='date', how='left').dropna(subset=['bias_score'])

def test_threshold(threshold):
    merged['position'] = 0
    merged.loc[merged['bias_score'] > threshold, 'position'] = 1
    merged.loc[merged['bias_score'] < -threshold, 'position'] = -1
    merged['returns'] = merged['close'].pct_change()
    merged['strategy_returns'] = merged['position'].shift(1) * merged['returns']
    sr = merged['strategy_returns'].dropna()
    if len(sr) == 0:
        return {'Threshold': threshold, 'Signals': 0}
    cum = (1 + sr).cumprod()
    tot = cum.iloc[-1] - 1
    wins = sr[sr > 0]
    losses = sr[sr < 0]
    wr = len(wins) / len(sr) if len(sr) > 0 else 0
    pf = abs(wins.sum() / losses.sum()) if losses.sum() != 0 else float('inf')
    return {
        'Threshold': threshold,
        'Signals': int(merged['position'].abs().sum()),
        'Total Return': f"{tot:.2%}",
        'Win Rate': f"{wr:.2%}",
        'Profit Factor': f"{pf:.2f}",
    }

print("\n=== Ottimizzazione Soglia Bias Index ===\n")
results = [test_threshold(t) for t in [5, 10, 15, 20, 25, 30]]
print(f"{'Threshold':<12} {'Signals':<9} {'Return':<10} {'Win Rate':<9} {'PF':<6}")
print("-" * 50)
for r in results:
    print(f"{r['Threshold']:<12} {r['Signals']:<9} {r['Total Return']:<10} {r['Win Rate']:<9} {r['Profit Factor']:<6}")
