const fs = require("fs");
const DODO_URL = "https://checkout.dodopayments.com/buy/pdt_0NdP2vm9fv4FGj9BNOxHF?quantity=1";

let c = fs.readFileSync("src/app/page.tsx", "utf8");

const needle = "Get Alerts on Telegram";
const i = c.indexOf(needle);
const j = c.indexOf("</a>", i) + 4;

const btn = "\n          <a href=\"" + DODO_URL + "\" target=\"_blank\" rel=\"noopener noreferrer\" className=\"px-6 py-3 rounded-lg font-semibold text-sm transition-opacity hover:opacity-80\" style={{ background: \"#00D4FF\", color: \"#0A0A0F\" }}>Go Pro — €19/mo</a>";

c = c.slice(0, j) + btn + c.slice(j);

fs.writeFileSync("src/app/page.tsx", c);
console.log("✅ done");
