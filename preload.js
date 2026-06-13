const { contextBridge, ipcRenderer } = require('electron');

function safeOn(channel, cb) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, cb);
}

contextBridge.exposeInMainWorld('pawback', {
  // Listeners
  onSetScreen:       (cb) => safeOn('set-screen',      (e, type, pet, msg, extra) => cb(type, pet, msg, extra)),
  onSetMood:         (cb) => safeOn('set-mood',         (e, mood) => cb(mood)),
  onSetPet:          (cb) => safeOn('set-pet',          (e, pet)  => cb(pet)),
  onShowBubble:      (cb) => safeOn('show-bubble',      (e, msg)  => cb(msg)),
  onMuteChanged:     (cb) => safeOn('mute-changed',     (e, v)    => cb(v)),
  onPrePounce:       (cb) => safeOn('pre-pounce',       ()        => cb()),
  onPounceActive:    (cb) => safeOn('pounce-active',    (e, v)    => cb(v)),
  onPomodoroTick:    (cb) => safeOn('pomodoro-tick',    (e, data) => cb(data)),
  onBossModeChanged: (cb) => safeOn('boss-mode-changed',(e, v)    => cb(v)),

  // Actions
  pounceDone:      () => ipcRenderer.send('pounce-done'),
  logStrayReason:  (reason) => ipcRenderer.send('log-stray-reason', reason),
  breakOfferYes:   () => ipcRenderer.send('break-offer-yes'),
  breakOfferNo:    () => ipcRenderer.send('break-offer-no'),
  breakConfirmYes: () => ipcRenderer.send('break-confirm-yes'),
  breakConfirmNo:  () => ipcRenderer.send('break-confirm-no'),
  snoozeApp:       (appName, minutes) => ipcRenderer.send('snooze-app', { appName, minutes }),
  saveSettings:    (s)    => ipcRenderer.send('save-settings', s),
  closeReportCard: ()     => ipcRenderer.send('close-report-card'),
  openDashboard:   ()     => ipcRenderer.send('open-dashboard'),
  pomodoroStart:   (workMin, breakMin) => ipcRenderer.send('pomodoro-start', { workMin, breakMin }),
  pomodoroStop:    ()     => ipcRenderer.send('pomodoro-stop'),
  toggleBossMode:  ()     => ipcRenderer.send('toggle-boss-mode'),
  switchToApp:     (name) => ipcRenderer.send('switch-to-app', name),

  // Queries
  getSettings:         () => ipcRenderer.invoke('get-settings'),
  getSessionStats:     () => ipcRenderer.invoke('get-session-stats'),
  getRunningProcesses: () => ipcRenderer.invoke('get-running-processes'),
  getBossMode:         () => ipcRenderer.invoke('get-boss-mode'),
});