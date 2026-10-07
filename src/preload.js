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
  setChromeHeight: send('chrome-height'),
  setModal: send('modal'),
  passwordPrompt: send('pw-prompt'),
  fillPassword: send('pw-fill'),
  copyPassword: send('pw-copy'),
  removePassword: send('pw-remove'),
  addPreset: send('preset-add'),
  authResponse: send('auth-response'),
  scanDevices: send('scan-devices'),
  fetchDeviceStatus: send('fetch-device-status'),
  openDevice: send('open-device'),
  on: (channel, callback) => {
    const allowed = ['tabs', 'downloads', 'passwords', 'show-panel', 'focus-address', 'auth-request', 'devices', 'scan-state', 'device-status', 'status-state', 'toggle-navbar'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, data) => callback(data));
  },
});
