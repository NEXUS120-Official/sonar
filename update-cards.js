const fs = require("fs");
const path = "src/app/page.tsx";
let c = fs.readFileSync(path, "utf8");

const oldGetBias = `async function getBias() {
  try {
    const db = createAdminClient();
    const { data } = await db
      .from("flow_snapshots")
      .select("bias_score, market_bias, snapshot_time")
      .eq("window_hours", 24)
      .order("snapshot_time", { ascending: false })
      .limit(1)
      .maybeSingle();
    const s = data as Pick<FlowSnapshotRow, "bias_score" | "market_bias" | "snapshot_time"> | null;
    return { score: s?.bias_score ?? null, label: s?.market_bias ?? null, time: s?.snapshot_time ?? null };
  } catch {
    return { score: null, label: null, time: null };
  }
}`;

const newGetBias = `async function getBias() {
  try {
    const db = createAdminClient();
    const { data } = await db
      .from("flow_snapshots")
      .select("*")
      .eq("window_hours", 24)
      .order("snapshot_time", { ascending: false })
      .limit(1)
      .maybeSingle();
    const s = data as FlowSnapshotRow | null;
    const netExchange = s?.sol_net_exchange_flow_usd ?? null;
    const netStaking = s?.net_staking_flow_usd ?? null;
    return {
      score: s?.bias_score ?? null,
      label: s?.market_bias ?? null,
      time: s?.snapshot_time ?? null,
      netExchangeFormatted: netExchange != null ? "$" + (netExchange / 1e6).toFixed(1) + "M" : "$0.0M",
      netExchangeLabel: netExchange != null && netExchange > 0 ? "Net Inflow ▼" : netExchange != null && netExchange < 0 ? "Net Outflow ▲" : "Balanced",
      netStakingFormatted: netStaking != null ? (netStaking > 0 ? "+" : "") + "$" + (netStaking / 1e6).toFixed(1) + "M" : "+$0.0M",
      netStakingLabel: netStaking != null && netStaking > 0 ? "Net Staked ▲" : netStaking != null && netStaking < 0 ? "Net Unstaked ▼" : "Balanced",
    };
  } catch {
    return { score: null, label: null, time: null, netExchangeFormatted: "$0.0M", netExchangeLabel: "Balanced", netStakingFormatted: "+$0.0M", netStakingLabel: "Balanced" };
  }
}`;

c = c.replace(oldGetBias, newGetBias);
c = c.replace(/>\$18\.7M</, ">{bias.netExchangeFormatted}<");
c = c.replace(/>Net Inflow .</, ">{bias.netExchangeLabel}<");
c = c.replace(/>\+\$0\.8M</, ">{bias.netStakingFormatted}<");
c = c.replace(/>Net Staked .</, ">{bias.netStakingLabel}<");

fs.writeFileSync(path, c);
console.log("done");
