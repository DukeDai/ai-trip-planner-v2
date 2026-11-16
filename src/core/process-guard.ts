/**
 * 进程级安全网。
 *
 * 为什么需要：deepagents 的部分内置工具（grep / glob）**没有内部 try/catch**，
 * 参数不合法时抛出的异常会一路冒泡成未捕获的 Promise rejection。
 * Node 20+ 的默认行为是把未捕获 rejection 升级成未捕获异常并**终止进程**，
 * 于是一趟十几分钟的真实规划（连同 checkpoint、SSE 进度）全部作废。
 *
 * 这里把这类异常降级成「记日志 + 继续跑」：
 *  - agent 的状态在 PG checkpoint 里，单个工具失败不影响后续回合；
 *  - 相比整轮跑挂，这是明显更好的结果。
 *
 * 真正的逻辑错误（bug）不该被吞掉 —— 所以这里**必须打印完整堆栈**，
 * 让日志里能一眼看到问题，而不是消失。
 */

export interface ProcessGuardOptions {
  /** 打印日志的函数，默认 console.error */
  log?: (message: string) => void;
}

export function installProcessGuard(options: ProcessGuardOptions = {}): void {
  const log = options.log ?? ((m: string) => console.error(m));

  process.on("unhandledRejection", (reason) => {
    log("[process-guard] 未捕获的 Promise 拒绝（已忽略，进程继续）：" + format(reason));
    if (reason instanceof Error && reason.stack) log(reason.stack);
  });

  process.on("uncaughtException", (err) => {
    log("[process-guard] 未捕获异常（已忽略，进程继续）：" + format(err));
    if (err instanceof Error && err.stack) log(err.stack);
  });
}

function format(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
