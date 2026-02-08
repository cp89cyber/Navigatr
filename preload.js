const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("adblock", {
  getState() {
    return ipcRenderer.invoke("adblock:get-state");
  },
  setEnabled(enabled) {
    return ipcRenderer.invoke("adblock:set-enabled", Boolean(enabled));
  },
  onStats(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    const forwardState = (_event, state) => {
      listener(state);
    };

    ipcRenderer.on("adblock:stats", forwardState);
    ipcRenderer.on("adblock:state", forwardState);

    return () => {
      ipcRenderer.removeListener("adblock:stats", forwardState);
      ipcRenderer.removeListener("adblock:state", forwardState);
    };
  }
});
