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

# Calcola indicatori di volume
df_prices['volume_ma20'] = df_prices['volume'].rolling(20).mean()
df_prices['volume_ratio'] = df_prices['volume'] / df_prices['volume_ma20']

snap = df[df['window_hours'] == 24].groupby('date').agg(
    bias_score=('bias_score', 'last'),
    sol_net_exchange_flow_usd=('sol_net_exchange_flow_usd', 'last'),
    net_staking_flow_usd=('net_staking_flow_usd', 'last'),
    net_defi_flow_usd=('net_defi_flow_usd', 'last')
).reset_index()
merged = df_prices.merge(snap, on='date', how='left').dropna(subset=['bias_score'])

def test_volume_filter(label, vol_threshold=None):
    df = merged.copy()
    df['position'] = 0
    if vol_threshold:
        df.loc[(df['bias_score'] > 20) & (df['volume_ratio'] > vol_threshold), 'position'] = 1
        df.loc[(df['bias_score'] < -20) & (df['volume_ratio'] > vol_threshold), 'position'] = -1
    else:
        df.loc[df['bias_score'] > 20, 'position'] = 1
        df.loc[df['bias_score'] < -20, 'position'] = -1
    df['returns'] = df['close'].pct_change()
    df['strategy_returns'] = df['position'].shift(1) * df['returns']
    sr = df['strategy_returns'].dropna()
    if len(sr) == 0:
        return {'Label': label, 'Signals': 0}
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
        'Label': label, 'Days': len(sr), 'Signals': int(df['position'].abs().sum()),
        'Total Return': f"{tot:.2%}", 'Sharpe': f"{sharpe:.2f}", 'Max DD': f"{mdd:.2%}",
        'Win Rate': f"{wr:.2%}", 'Profit Factor': f"{pf:.2f}"
    }

results = [
    test_volume_filter('Base (no vol)'),
    test_volume_filter('Vol > 1.0x avg', 1.0),
    test_volume_filter('Vol > 1.2x avg', 1.2),
    test_volume_filter('Vol > 1.5x avg', 1.5),
    test_volume_filter('Vol > 2.0x avg', 2.0),
]

print("\n=== Backtest Filtro Volume ===\n")
print(f"{'Filtro':<18} {'Days':<6} {'Signals':<8} {'Return':<10} {'Sharpe':<8} {'Max DD':<9} {'Win Rate':<9} {'PF':<6}")
print("-" * 80)
for r in results:
    print(f"{r['Label']:<18} {r['Days']:<6} {r['Signals']:<8} {r['Total Return']:<10} {r['Sharpe']:<8} {r['Max DD']:<9} {r['Win Rate']:<9} {r['Profit Factor']:<6}")
