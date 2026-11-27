/**
 * 小红书删除兜底：创作平台把删除接口迁到了前端私有接口，旧的
 * /api/galaxy/creator/note/delete 已返回 404。这里复用登录态打开笔记管理页，
 * 按笔记 ID 找到卡片，点击删除并确认。
 */
import { log } from "../../core/log";

export async function deleteXhsNoteViaUi(
  cookieMap: Record<string, string>,
  noteId: string,
  proxy = ""
): Promise<{ ok: boolean; message: string }> {
  const { app, BrowserWindow, session: electronSession } = require("electron") as typeof import("electron");
  if (!app.isReady()) return { ok: false, message: "桌面环境尚未就绪，无法打开小红书笔记管理" };
  const partition = `xhs-delete-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ses = electronSession.fromPartition(partition, { cache: false });
  if (proxy) {
    try {
      await ses.setProxy({ proxyRules: proxy.includes("://") ? proxy : `http://${proxy}` });
    } catch {
      /* 代理失败时仍尝试直连 */
    }
  }
  for (const [name, value] of Object.entries(cookieMap)) {
    try {
      await ses.cookies.set({
        url: "https://creator.xiaohongshu.com",
        name,
        value,
        domain: ".xiaohongshu.com",
        path: "/",
        secure: true,
      });
    } catch {
      /* 单个 Cookie 写不进去不影响其它 Cookie */
    }
  }
  let win: InstanceType<typeof BrowserWindow> | null = null;
  try {
    win = new BrowserWindow({
      width: 1440,
      height: 1000,
      show: false,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.webContents.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
    await win.loadURL("https://creator.xiaohongshu.com/new/note-manager");
    const target = JSON.stringify(noteId);
    let ready = false;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      ready = Boolean(
        await win.webContents.executeJavaScript(
          `Boolean(Array.from(document.querySelectorAll('.note-card')).find((c) => (c.getAttribute('data-impression') || '').includes(${target})))`
        )
      );
      if (ready) break;
    }
    if (!ready) {
      return { ok: false, message: "小红书笔记管理页没有加载出目标笔记，请稍后重试" };
    }
    const result = await win.webContents.executeJavaScript(`(async () => {
      const id = ${target};
      const card = Array.from(document.querySelectorAll('.note-card'))
        .find((c) => (c.getAttribute('data-impression') || '').includes(id));
      if (!card) return { ok: false, reason: 'card_missing' };
      const del = card.querySelector('.note-card__action-btn--del');
      if (!del) return { ok: false, reason: 'button_missing' };
      del.click();
      await new Promise((r) => setTimeout(r, 900));
      const modal = document.querySelector('.d-modal, [class*=modal], [class*=dialog]');
      if (!modal) return { ok: false, reason: 'modal_missing' };
      const buttons = Array.from(modal.querySelectorAll('button, .d-button, [class*=btn]'));
      const confirm = buttons.find((b) => /确定|删除/.test((b.innerText || '').trim()) && !/取消/.test((b.innerText || '').trim()));
      if (!confirm) return { ok: false, reason: 'confirm_missing' };
      confirm.click();
      await new Promise((r) => setTimeout(r, 2200));
      const still = Array.from(document.querySelectorAll('.note-card'))
        .some((c) => (c.getAttribute('data-impression') || '').includes(id));
      return { ok: !still, still };
    })()`);
    if (result && result.ok) return { ok: true, message: "小红书笔记已删除" };
    log.warn(`小红书界面删除未完成: ${JSON.stringify(result)}`);
    return { ok: false, message: "小红书界面删除未完成，请到创作中心手动确认" };
  } catch (error) {
    log.error(`小红书界面删除异常: ${error instanceof Error ? error.stack : String(error)}`);
    return { ok: false, message: "小红书删除页面打开失败，请稍后重试" };
  } finally {
    try {
      win?.destroy();
      await electronSession.fromPartition(partition).clearStorageData();
    } catch {
      /* ignore */
    }
  }
}
