/** 后台任务中心：把耗时生成移出请求线程，前端按 task_id 轮询。 */
import { randomBytes } from "node:crypto";
import { now } from "../core/config";
import { log } from "../core/log";

interface Task {
  id: string;
  kind: string;
  status: string;
  message: string;
  result: unknown;
  error: string;
  created_at: number;
  finished_at: number;
  deadline_at: number;
}

const tasks = new Map<string, Task>();
const running = new Map<string, string>();
const KEEP = 50;

function expire(): void {
  const stamp = now();
  for (const task of tasks.values()) {
    if (task.status !== "running") continue;
    if (!task.deadline_at || stamp < task.deadline_at) continue;
    task.status = "failed";
    task.error = "处理超时，请重试；已保留当前输入";
    task.message = "处理超时，请重试";
    task.finished_at = stamp;
    for (const [key, id] of running) {
      if (id === task.id) running.delete(key);
    }
    log.warn(`后台任务 ${task.id} 超时，已标记失败: ${task.kind}`);
  }
}

function prune(): void {
  if (tasks.size <= KEEP) return;
  const finished = [...tasks.values()]
    .filter((task) => task.status !== "running")
    .sort((left, right) => left.created_at - right.created_at);
  for (const task of finished.slice(0, Math.max(0, tasks.size - KEEP))) {
    tasks.delete(task.id);
  }
}

export function submit(
  kind: string,
  key: string,
  work: () => unknown,
  timeoutSec = 900
): Record<string, unknown> {
  expire();
  const runningId = running.get(key);
  if (runningId) {
    const current = tasks.get(runningId);
    if (current?.status === "running") return { ...current, existed: true };
  }
  const id = randomBytes(6).toString("hex");
  const stamp = now();
  const task: Task = {
    id,
    kind,
    status: "running",
    message: "正在处理，完成后会自动刷新",
    result: null,
    error: "",
    created_at: stamp,
    finished_at: 0,
    deadline_at: stamp + Math.max(1, Math.trunc(timeoutSec)),
  };
  tasks.set(id, task);
  running.set(key, id);
  prune();
  setTimeout(() => {
    let outcome: Record<string, unknown>;
    try {
      const result = work();
      let message = "处理完成";
      if (Array.isArray(result)) {
        if (kind === "published") {
          const okCount = result.filter((item) => item && (item as Record<string, unknown>).ok).length;
          message = `已同步 ${result.length} 个账号，成功 ${okCount} 个`;
        } else {
          message = `已生成 ${result.length} 篇草稿`;
        }
      }
      outcome = { status: "success", result, message };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      outcome = { status: "failed", error: text, message: text };
      log.error(`后台任务 ${id} 执行失败: ${text}`);
    }
    const current = tasks.get(id);
    if (current && current.status === "running") {
      Object.assign(current, outcome);
      current.finished_at = now();
    }
    if (running.get(key) === id) running.delete(key);
  }, 0);
  return { ...task };
}

export function getTask(taskId: string): Record<string, unknown> {
  expire();
  const task = tasks.get(taskId);
  if (!task) throw Object.assign(new Error(`任务不存在或已过期: ${taskId}`), { status: 404 });
  return { ...task };
}
