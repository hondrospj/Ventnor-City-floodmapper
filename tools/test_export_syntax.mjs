import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const scriptPattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
let compiled = 0;

for (const match of html.matchAll(scriptPattern)) {
  const attributes = match[1];
  const source = match[2];
  if (/\bsrc\s*=/.test(attributes)) continue;
  if (/\btype\s*=\s*["']application\/ld\+json["']/.test(attributes)) continue;
  new vm.Script(source, { filename: `index.html:inline-${compiled + 1}` });
  compiled += 1;
}

if (!compiled) throw new Error("No inline JavaScript blocks were found");
console.log(`Compiled ${compiled} inline scripts`);
