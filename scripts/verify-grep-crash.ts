/**
 * 崩溃复现验证：含 null 字节的 grep 参数。
 *
 * 复现的是真实调用链：
 *   deepagents 的 grep 工具 → FilesystemBackend.grep → ripgrepSearch → spawn("rg", args)
 *
 * 两段对比：
 *   raw    —— 直接调 deepagents 的 grep 工具（复现原始事故）
 *   guarded —— 经过 ToolGuard 中间件后再调（验证修复有效）
 *
 * 用法：node scripts/verify-grep-crash.ts raw | guarded
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FilesystemBackend, createFilesystemMiddleware } from "deepagents";
import { createToolGuardMiddleware } from "../src/agent/tool-guard.ts";
import { installProcessGuard } from "../src/core/process-guard.ts";

const mode = process.argv[2] ?? "guarded";
installProcessGuard();

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tpgrep-"));
fs.writeFileSync(path.join(root, "a.txt"), "hello\nworld\n");
const backend = new FilesystemBackend({ rootDir: root, virtualMode: true });

// deepagents 内置的文件系统工具（agent 实际挂的就是这一套）
const fsTools = createFilesystemMiddleware({ backend }).tools ?? [];
const grep = fsTools.find((t) => t.name === "grep");
if (!grep) {
  console.error("没找到 grep 工具，可用：", fsTools.map((t) => t.name).join(", "));
  process.exit(2);
}

const NUL = String.fromCharCode(0);
const BS = String.fromCharCode(8);
const badPattern = "[" + NUL + "-" + BS + "]";

console.log(
  "[verify] mode =",
  mode,
  "| pattern 字符码 =",
  [...badPattern].map((c) => c.charCodeAt(0)).join(",")
);

async function runGuarded(): Promise<void> {
  const mw = createToolGuardMiddleware() as unknown as {
    wrapToolCall: (req: unknown, handler: unknown) => Promise<{ content: string; status?: string }>;
  };
  const msg = await mw.wrapToolCall(
    { toolCall: { id: "c1", name: "grep", args: { pattern: badPattern, path: "/" } } },
    async (req: { toolCall: { args: Record<string, unknown> } }) => {
      // 净化后的参数真的进了工具
      return await grep.invoke(req.toolCall.args) as unknown;
    }
  );
  const text = typeof msg === "string" ? msg : String((msg as { content?: unknown }).content ?? msg);
  console.log("[verify] 经防护返回：", JSON.stringify(text).slice(0, 240));
  console.log("[verify] status =", (msg as { status?: string })?.status ?? "success");
}

try {
  if (mode === "raw") {
    const out = await grep.invoke({ pattern: badPattern, path: "/" });
    console.log("[verify] raw 调用完成，返回：", JSON.stringify(String(out)).slice(0, 200));
  } else {
    await runGuarded();
  }
  console.log("[verify] 结论：没有崩溃");
} catch (err) {
  console.log("[verify] 调用抛出异常：", err instanceof Error ? err.message : String(err));
  console.log("[verify] 结论：异常逃逸 —— 无防护时这就是那次「整趟规划被打死」的事故");
}
