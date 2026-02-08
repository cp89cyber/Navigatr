const { contextBridge, ipcRenderer } = require("electron");

const IPC_CHANNELS = Object.freeze({
  navigate: "browser:navigate",
  back: "browser:back",
  forward: "browser:forward",
  reload: "browser:reload",
  setToolbarHeight: "browser:set-toolbar-height",
  getState: "browser:get-state",
  state: "browser:state"
});

contextBridge.exposeInMainWorld("browser", {
  navigate(rawInput) {
    return ipcRenderer.invoke(IPC_CHANNELS.navigate, rawInput);
  },
  back() {
    return ipcRenderer.invoke(IPC_CHANNELS.back);
  },
  forward() {
    return ipcRenderer.invoke(IPC_CHANNELS.forward);
  },
  reload() {
    return ipcRenderer.invoke(IPC_CHANNELS.reload);
  },
  setToolbarHeight(px) {
    return ipcRenderer.invoke(IPC_CHANNELS.setToolbarHeight, px);
  },
  getState() {
    return ipcRenderer.invoke(IPC_CHANNELS.getState);
  },
  onStateChange(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    const wrapped = (_event, state) => {
      listener(state);
    };

    ipcRenderer.on(IPC_CHANNELS.state, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.state, wrapped);
    };
  }
});
