const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pawback', {
  // peek / pounce windows
  onSetScreen: (cb) => ipcRenderer.on('set-screen', (e, type, pet, msg, extra) => cb(type, pet, msg, extra)),
  onSetMood:   (cb) => ipcRenderer.on('set-mood',   (e, mood) => cb(mood)),
  onSetPet:    (cb) => ipcRenderer.on('set-pet',    (e, pet)  => cb(pet)),
  onShowBubble:(cb) => ipcRenderer.on('show-bubble',(e, msg)  => cb(msg)),
  onMuteChanged:(cb)=> ipcRenderer.on('mute-changed',(e, v)   => cb(v)),

  pounceDone:      () => ipcRenderer.send('pounce-done'),
  breakOfferYes:   () => ipcRenderer.send('break-offer-yes'),
  breakOfferNo:    () => ipcRenderer.send('break-offer-no'),
  breakConfirmYes: () => ipcRenderer.send('break-confirm-yes'),
  breakConfirmNo:  () => ipcRenderer.send('break-confirm-no'),
  snoozeApp: (appName, minutes) => ipcRenderer.send('snooze-app', { appName, minutes }),

  // data
  getSettings:        () => ipcRenderer.invoke('get-settings'),
  getSessionStats:    () => ipcRenderer.invoke('get-session-stats'),
  getRunningProcesses:() => ipcRenderer.invoke('get-running-processes'),
  saveSettings: (s)   => ipcRenderer.send('save-settings', s),
  closeReportCard:    () => ipcRenderer.send('close-report-card'),
});