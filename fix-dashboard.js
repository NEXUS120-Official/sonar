const fs = require("fs");
let c = fs.readFileSync("src/app/dashboard/page.tsx", "utf8");
c = c.replace(
  "import { BiasGauge } from '@/components/BiasGauge';",
  "import { FlowGauge } from '@/components/FlowGauge';"
);
c = c.replace(
  /<BiasGauge[\s\S]*?\/>/,
  "<FlowGauge score={biasScore} label={biasBias} size={200} />"
);
fs.writeFileSync("src/app/dashboard/page.tsx", c);
console.log("✅ FlowGauge attivato nella dashboard");
