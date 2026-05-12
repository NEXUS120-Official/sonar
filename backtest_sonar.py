import pandas as pd
import numpy as np
import json
from pathlib import Path

# Caricamento dati
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

# Allineamento temporale
df_sonar['date'] = df_sonar['snapshot_time'].dt.date
df_sonar_daily = df_sonar.groupby('date').agg({
    'bias_score': 'last',
    'market_bias': 'last'
}).reset_index()

df_prices['date'] = df_prices['timestamp'].dt.date
df_merged = pd.merge(df_prices, df_sonar_daily, on='date', how='left')
df_merged = df_merged.dropna(subset=['bias_score'])

# Strategia
def generate_signals(df, long_threshold=20, short_threshold=-20):
    df = df.copy()
    df['position'] = 0
    df.loc[df['bias_score'] > long_threshold, 'position'] = 1
    df.loc[df['bias_score'] < short_threshold, 'position'] = -1
    df['returns'] = df['close'].pct_change()
    df['strategy_returns'] = df['position'].shift(1) * df['returns']
    return df

df_signals = generate_signals(df_merged)

# Metriche
def calculate_metrics(strategy_returns):
    cumulative = (1 + strategy_returns).cumprod()
    total_return = cumulative.iloc[-1] - 1
    annualized_return = (1 + total_return) ** (365 / len(strategy_returns)) - 1
    annualized_vol = strategy_returns.std() * np.sqrt(365)
    sharpe = annualized_return / annualized_vol if annualized_vol > 0 else 0
    rolling_max = cumulative.cummax()
    drawdown = (cumulative - rolling_max) / rolling_max
    max_dd = drawdown.min()
    wins = strategy_returns[strategy_returns > 0]
    losses = strategy_returns[strategy_returns < 0]
    win_rate = len(wins) / len(strategy_returns) if len(strategy_returns) > 0 else 0
    profit_factor = abs(wins.sum() / losses.sum()) if losses.sum() != 0 else float('inf')
    return {
        'Total Return': f"{total_return:.2%}",
        'Annualized Return': f"{annualized_return:.2%}",
        'Annualized Vol': f"{annualized_vol:.2%}",
        'Sharpe Ratio': f"{sharpe:.2f}",
        'Max Drawdown': f"{max_dd:.2%}",
        'Win Rate': f"{win_rate:.2%}",
        'Profit Factor': f"{profit_factor:.2f}",
        'Days': len(strategy_returns)
    }

metrics = calculate_metrics(df_signals['strategy_returns'].dropna())
print("=== SONAR Backtest Results ===")
for k, v in metrics.items():
    print(f"{k}: {v}")

# Permutation test (robust version)
np.random.seed(42)
n_perm = 100
perm_returns = []
for _ in range(n_perm):
    shuffled = df_signals['position'].sample(frac=1).reset_index(drop=True)
    perm_ret = (shuffled.shift(1) * df_signals['returns'])
    perm_ret = perm_ret.dropna()
    if len(perm_ret) > 0:
        perm_returns.append((1 + perm_ret).cumprod().iloc[-1])

original = (1 + df_signals['strategy_returns'].dropna()).cumprod().iloc[-1]
perm_returns = np.array(perm_returns)
perm_returns = perm_returns[~np.isnan(perm_returns)]

if len(perm_returns) > 0:
    p_value = np.mean(perm_returns >= original)
    print(f"\nPermutation test: original={original:.4f}, mean perm={np.mean(perm_returns):.4f}, p-value={p_value:.4f}")
    print("Edge confirmed (p<0.05)" if p_value < 0.05 else "No significant edge (p>=0.05)")
else:
    print("\nPermutation test: insufficient data")
