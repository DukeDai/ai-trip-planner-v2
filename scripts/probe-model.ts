/**
 * 用量探测：发一次极小的模型调用，只回状态码与耗时，绝不打印凭据。
 * 用法：node scripts/probe-model.ts
 */
import { loadConfig } from "../src/config.ts";
import { createModel } from "../src/agent/build.ts";

const config = loadConfig();
if (!config.llm.apiKey) {
  console.log(JSON.stringify({ ok: false, reason: "no-credential" }));
  process.exit(2);
}
const model = createModel(config, { thinking: "disabled" });
const started = Date.now();
try {
  const res = await model.invoke([
    { role: "user", content: "只回复两个字：可用" }
  ]);
  const content = res.content as unknown;
  let text = "";
  if (Array.isArray(content)) {
    text = content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("");
  } else if (typeof content === "string") {
    text = content;
  }
  console.log(
    JSON.stringify({
      ok: true,
      model: config.llm.model,
      keySource: config.llm.keySource,
      ms: Date.now() - started,
      reply: text.slice(0, 40)
    })
  );
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(
    JSON.stringify({
      ok: false,
      model: config.llm.model,
      ms: Date.now() - started,
      error: msg.slice(0, 600)
    })
  );
  process.exit(1);
}
