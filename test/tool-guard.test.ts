import test from "node:test";
import assert from "node:assert/strict";
import { getHarnessProfile } from "deepagents";
import { stripControlChars, sanitizeToolArgs, createToolGuardMiddleware } from "../src/agent/tool-guard.ts";
import { disableGeneralPurposeSubagent } from "../src/agent/build.ts";

// 用 fromCharCode 构造控制字符，避免源码里的转义层级歧义
const NUL = String.fromCharCode(0);
const BS = String.fromCharCode(8);
const VT = String.fromCharCode(11);
const FF = String.fromCharCode(12);
const SO = String.fromCharCode(14);
const US = String.fromCharCode(31);
const DEL = String.fromCharCode(127);

test("stripControlChars 去掉 null 字节与控制字符，保留 \\t \\n \\r", () => {
  assert.equal(stripControlChars("a" + NUL + "b"), "ab");
  assert.equal(stripControlChars("[" + NUL + "-" + BS + VT + FF + SO + "-" + US + "]"), "[--]");
  assert.equal(stripControlChars("a" + DEL + "b"), "ab");
  assert.equal(stripControlChars("a\tb\nc\rd"), "a\tb\nc\rd");
  assert.equal(stripControlChars("正常中文"), "正常中文");
});

test("sanitizeToolArgs 只作用于文件系统类工具", () => {
  const dirty = { pattern: "a" + NUL + "b", path: "/x" };
  const fs = sanitizeToolArgs("grep", dirty);
  assert.equal(fs.args.pattern, "ab");
  assert.deepEqual(fs.changed, ["pattern"]);

  const other = sanitizeToolArgs("search_sights", dirty);
  assert.equal(other.args.pattern, "a" + NUL + "b", "非文件系统工具不应被改写");
  assert.deepEqual(other.changed, []);
});

test("sanitizeToolArgs：pattern 含控制字符判为无效调用", () => {
  const res = sanitizeToolArgs("grep", { pattern: NUL + BS });
  assert.equal(res.invalid, true);
});

test("sanitizeToolArgs：glob 里的控制字符只被剥离，不算无效", () => {
  const res = sanitizeToolArgs("grep", { pattern: "keyword", glob: "*.md" + NUL });
  assert.equal(res.args.glob, "*.md");
  assert.equal(res.invalid, false);
});

test("工具防护中间件：pattern 只有控制字符时不执行工具，直接回错误", async () => {
  const mw = createToolGuardMiddleware() as unknown as {
    wrapToolCall: (req: unknown, handler: unknown) => Promise<{ content: string; status?: string }>;
  };
  let called = false;
  const handler = async () => {
    called = true;
    return { content: "不该走到这里" };
  };
  const msg = await mw.wrapToolCall(
    { toolCall: { id: "call_1", name: "grep", args: { pattern: NUL + BS } } },
    handler
  );
  assert.equal(called, false, "无效调用不应进入工具实现");
  assert.equal(msg.status, "error");
  assert.match(String(msg.content), /字面量/);
});

test("工具防护中间件：pattern 含控制字符时提示 grep 是字面量搜索", async () => {
  const mw = createToolGuardMiddleware() as unknown as {
    wrapToolCall: (req: unknown, handler: unknown) => Promise<{ content: string; status?: string }>;
  };
  const msg = await mw.wrapToolCall(
    { toolCall: { id: "call_1b", name: "grep", args: { pattern: "[" + NUL + "-" + BS + "]" } } },
    async () => ({ content: "不该走到这里" })
  );
  assert.equal(msg.status, "error");
  assert.match(String(msg.content), /已净化为/);
  assert.match(String(msg.content), /字面量/);
});

test("工具防护中间件：工具内部抛错时转成 error ToolMessage，不向上抛", async () => {
  const mw = createToolGuardMiddleware() as unknown as {
    wrapToolCall: (req: unknown, handler: unknown) => Promise<{ content: string; status?: string }>;
  };
  const handler = async () => {
    throw new Error("ERR_INVALID_ARG_VALUE: must be a string without null bytes");
  };
  const msg = await mw.wrapToolCall(
    { toolCall: { id: "call_2", name: "grep", args: { pattern: "x" } } },
    handler
  );
  assert.equal(msg.status, "error");
  assert.match(String(msg.content), /ERR_INVALID_ARG_VALUE/);
  assert.match(String(msg.content), /行程规划本身没有失败/);
});

test("工具防护中间件：净化后的参数会真正传给工具", async () => {
  const mw = createToolGuardMiddleware() as unknown as {
    wrapToolCall: (req: unknown, handler: unknown) => Promise<unknown>;
  };
  let seen: Record<string, unknown> | null = null;
  const handler = async (req: { toolCall: { args: Record<string, unknown> } }) => {
    seen = req.toolCall.args;
    return { content: "ok" };
  };
  await mw.wrapToolCall(
    { toolCall: { id: "call_3", name: "grep", args: { pattern: "keyword", glob: "*.md" + NUL } } },
    handler
  );
  assert.equal((seen as unknown as { glob: string }).glob, "*.md");
});

test("工具防护中间件：改稿次数到顶后挡住 edit_file，并指路 submit → finalize", async () => {
  const mw = createToolGuardMiddleware() as unknown as {
    wrapToolCall: (req: unknown, handler: unknown) => Promise<{ content: string; status?: string }>;
  };
  let ok = 0;
  const handler = async () => {
    ok++;
    return { content: "edited" };
  };
  // 先跑满预算
  for (let i = 0; i < 300; i++) {
    await mw.wrapToolCall({ toolCall: { id: "e" + i, name: "edit_file", args: { path: "x" } } }, handler);
  }
  assert.equal(ok, 300);
  const blocked = await mw.wrapToolCall(
    { toolCall: { id: "e-block", name: "edit_file", args: { path: "x" } } },
    handler
  );
  assert.equal(ok, 300, "到顶后不应再执行 edit_file");
  assert.equal(blocked.status, "error");
  assert.match(String(blocked.content), /改稿次数已达上限/);
  assert.match(String(blocked.content), /submit_itinerary/);
});

test("general-purpose 子代理已被禁用（harness profile）", () => {
  disableGeneralPurposeSubagent();
  const profile = getHarnessProfile("anthropic");
  assert.ok(profile, "anthropic profile 应已注册");
  assert.equal(profile.generalPurposeSubagent?.enabled, false);
});
