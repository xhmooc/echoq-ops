import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("echoq", {
  /** 打开系统文件选择器，返回封面图绝对路径。 */
  pickImage: (): Promise<string> => ipcRenderer.invoke("echoq:pick-image"),
});

// 页面自绘标题栏使用：最小化 / 最大化切换 / 关闭 / 最大化状态同步。
contextBridge.exposeInMainWorld("electronWin", {
  minimize: (): void => ipcRenderer.send("echoq:win", "minimize"),
  toggleMaximize: (): void => ipcRenderer.send("echoq:win", "maximize"),
  close: (): void => ipcRenderer.send("echoq:win", "close"),
  onMaximized: (callback: (maximized: boolean) => void): void => {
    ipcRenderer.on("echoq:maximized", (_event, maximized) => callback(Boolean(maximized)));
  },
});
