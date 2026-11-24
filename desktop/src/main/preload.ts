import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("echoq", {
  /** 打开系统文件选择器，返回封面图绝对路径。 */
  pickImage: (): Promise<string> => ipcRenderer.invoke("echoq:pick-image"),
});
