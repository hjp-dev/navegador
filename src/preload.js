const { contextBridge, ipcRenderer } = require('electron');

const send = (channel) => (arg) => ipcRenderer.send(channel, arg);

contextBridge.exposeInMainWorld('browser', {
  navigate: send('navigate'),
  back: send('back'),
  forward: send('forward'),
  reload: send('reload'),
  newTab: send('new-tab'),
  closeTab: send('close-tab'),
  activateTab: send('activate-tab'),
  toggleBookmark: send('toggle-bookmark'),
  removeBookmark: send('remove-bookmark'),
  openBookmark: send('open-bookmark'),
  setPanel: send('panel'),
  downloadAction: send('download-action'),
  clearDownloads: send('clear-downloads'),
  on: (channel, callback) => {
    const allowed = ['tabs', 'downloads', 'show-panel', 'focus-address'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, data) => callback(data));
  },
});
