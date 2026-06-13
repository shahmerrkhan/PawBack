require('dotenv').config();
const { app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch (e) {
    return {
      allowedApps: ['Code', 'opera', 'explorer'],
      pet: 'cat.svg',
      breakDurationMin: 10,
      pauseDurationMin: 60,
      streak: 0,
      lastActiveDate: '',
      dailyGoalMin: 60,
      pounceTone: 'sassy',
      soundMuted: false,
      weeklyHistory: {},
    };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

let settings = loadSettings();
// backfill missing keys for existing settings.json files
if (!settings.pounceTone) settings.pounceTone = 'sassy';
if (settings.soundMuted === undefined) settings.soundMuted = false;
if (!settings.weeklyHistory) settings.weeklyHistory = {};

const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
$hwnd = [Win32]::GetForegroundWindow()
$procId = 0
[Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
(Get-Process -Id $procId).ProcessName
`;

const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

const fallbackMessages = {
  gentle: [
    "Hey, just a reminder to get back to work 🌸",
    "You drifted a little — no worries, come back!",
    "This isn't quite work mode, but you've got this 💪",
    "Just a gentle nudge back to your task 🐾",
    "A little off track — let's refocus together!",
  ],
  sassy: [
    "Bro. What are you doing. 🐾",
    "The cat sees everything. Get back.",
    "You thought I wouldn't notice? Cute.",
    "...really? RIGHT now?",
    "The audacity. Return. Immediately.",
    "You were so close. So close.",
  ],
  brutal: [
    "Absolutely pathetic. Get back to work.",
    "You call that focus? Embarrassing.",
    "Caught slacking AGAIN. Unbelievable.",
    "Your future self is disappointed in you.",
    "This is why you're not where you want to be.",
    "No breaks. No mercy. GO.",
  ],
};

const toneSystemPrompts = {
  gentle: 'You are a sweet, encouraging cat mascot for a focus app. The user drifted from their work. Give ONE gentle, warm nudge to go back, max 10 words, with a soft emoji. No quotes.',
  sassy: 'You are a sassy but cute cat mascot for a focus app. The user wanders off from their work — roast them gently. ONE short funny message, max 10 words, no quotes, end with an emoji maybe. Be playful not mean.',
  brutal: 'You are a brutal, no-nonsense drill-sergeant cat mascot. The user left their work. Give ONE harsh, blunt, slightly mean message to send them back, max 10 words. No coddling. No emoji unless it\'s 💀 or 😤.',
};

let lastAiMessage = fallbackMessages.sassy[0];
let pounceCount = 0; // declared early so fetchAiMessage can use it

function randomFallback() {
  const tone = settings.pounceTone || 'sassy';
  const msgs = fallbackMessages[tone];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

async function fetchAiMessage() {
  try {
    const https = require('https');
    const tone = settings.pounceTone || 'sassy';
    const body = JSON.stringify({
      model: 'llama3-8b-8192',
      max_tokens: 60,
      messages: [
        { role: 'system', content: toneSystemPrompts[tone] },
        { role: 'user', content: `User just switched away from work. Pounce count today: ${pounceCount}. Give me a new message.` }
      ]
    });

    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      }
    };

    const msg = await new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.choices?.[0]?.message?.content?.trim() || randomFallback());
          } catch { resolve(randomFallback()); }
        });
      });
      req.on('error', () => resolve(randomFallback()));
      req.setTimeout(4000, () => { req.destroy(); resolve(randomFallback()); });
      req.write(body);
      req.end();
    });

    lastAiMessage = msg;
  } catch {
    lastAiMessage = randomFallback();
  }
}

fetchAiMessage();

// ── Encouragements (escalate with focus streak) ──
const encouragementLevels = [
  // 0-7 min focused
  ["You're doing great, keep going!", "Look at you, locked in 💪", "Future you says thanks"],
  // 8-15 min
  ["On a roll! Don't stop now 🔥", "8 minutes of pure focus. Legend.", "The cat is proud of you 🐾"],
  // 16-23 min
  ["You're in the zone. Don't break it.", "16+ minutes locked in. Absolute beast.", "This is what discipline looks like 💪🔥"],
  // 24+ min
  ["You are UNSTOPPABLE. Keep going!! 🚀", "30 mins? The cat bows to you. 🙇", "Machine. Absolute machine. 🔥🔥🔥"],
];

async function fetchEncouragement(focusBucket) {
  const fallbacks = encouragementLevels[Math.min(focusBucket, encouragementLevels.length - 1)];
  try {
    const https = require('https');
    const hype = focusBucket >= 3 ? 'extremely hype and excited' : focusBucket >= 2 ? 'enthusiastic' : 'warm and supportive';
    const body = JSON.stringify({
      model: 'llama3-8b-8192',
      max_tokens: 30,
      messages: [
        { role: 'system', content: `You are a cute pet mascot for a focus app. The user has been focused for a while. Be ${hype}. Give ONE short encouragement, max 8 words, with an emoji. No quotes.` },
        { role: 'user', content: 'Encourage the user.' }
      ]
    });
    const options = {
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const msg = await new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.choices?.[0]?.message?.content?.trim() || null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(4000, () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
    return msg || fallbacks[Math.floor(Math.random() * fallbacks.length)];
  } catch {
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

let lastEncouragementAt = 0;
async function maybeShowEncouragement() {
  const now = Date.now();
  if (focusSeconds > 0 && focusSeconds % (8 * 60) === 0 && now - lastEncouragementAt > 60000) {
    lastEncouragementAt = now;
    const bucket = Math.floor(focusSeconds / (8 * 60)) - 1;
    const msg = await fetchEncouragement(bucket);
    if (peekWindow && !peekWindow.isDestroyed()) {
      peekWindow.webContents.send('show-bubble', msg);
    }
  }
}

function playSound(file) {
  if (settings.soundMuted) return;
  const soundPath = path.join(__dirname, 'sounds', file);
  exec(`powershell -c (New-Object Media.SoundPlayer '${soundPath}').PlaySync()`);
}

let peekWindow, pounceWindow, dashboardWindow, reportCardWindow, tray;

const sessionStart = Date.now();
let breaksTaken = 0;
let focusSeconds = 0;

let onBreak = false;
let breakEndsAt = null;
let justFinishedBreak = false;
let isPaused = false;
let pauseEndsAt = null;
let awaitingResponse = false;

// ── App snooze ──
let snoozedApps = {}; // { appName: expiresAt }

function isAppSnoozed(appName) {
  if (!snoozedApps[appName]) return false;
  if (Date.now() >= snoozedApps[appName]) {
    delete snoozedApps[appName];
    return false;
  }
  return true;
}

function snoozeApp(appName, minutes) {
  snoozedApps[appName] = Date.now() + minutes * 60 * 1000;
}

function createPeekWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  peekWindow = new BrowserWindow({
    width: 150, height: 150,
    x: width - 100, y: height - 190,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    resizable: false, focusable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  peekWindow.loadFile('peek.html');
}

function createPounceWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  pounceWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    resizable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  pounceWindow.loadFile('pounce.html');
}

function createDashboardWindow() {
  if (dashboardWindow) { dashboardWindow.focus(); return; }
  dashboardWindow = new BrowserWindow({
    width: 700, height: 580, title: 'PawBack',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  dashboardWindow.loadFile('dashboard.html');
  dashboardWindow.on('closed', () => { dashboardWindow = null; });
  app.on('window-all-closed', (e) => e.preventDefault());
}

function showScreen(type, extra) {
  const msg = type === 'pounce' ? lastAiMessage : '';
  pounceWindow.webContents.send('set-screen', type, settings.pet, msg, extra || null);
  if (!pounceWindow.isVisible()) pounceWindow.show();
  if (type === 'pounce') fetchAiMessage();
}

function hidePounce() {
  if (pounceWindow.isVisible()) pounceWindow.hide();
  awaitingResponse = false;
  updatePeekMood();
}

function updatePeekMood() {
  let mood = 'happy';
  if (pounceCount >= 6) mood = 'done';
  else if (pounceCount >= 3) mood = 'suspicious';
  if (peekWindow && !peekWindow.isDestroyed()) {
    peekWindow.webContents.send('set-mood', mood);
  }
}

let lastDetectedApp = '';

function getActiveWindow() {
  exec(`powershell -EncodedCommand ${encoded}`, (err, stdout) => {
    if (err) return;
    const lines = stdout.trim().split('\n');
    const appName = lines[lines.length - 1].trim();
    const now = Date.now();

    if (isPaused) {
      if (now >= pauseEndsAt) isPaused = false;
      else { hidePounce(); return; }
    }

    if (onBreak) {
      if (now >= breakEndsAt) {
        onBreak = false;
        justFinishedBreak = true;
        playSound('lockin.wav');
        showScreen('lockin');
      } else {
        hidePounce();
      }
      return;
    }

    if (justFinishedBreak) {
      if (settings.allowedApps.includes(appName)) {
        justFinishedBreak = false;
        hidePounce();
      }
      return;
    }

    if (awaitingResponse) {
      if (settings.allowedApps.includes(appName)) {
        awaitingResponse = false;
        hidePounce();
      }
      return;
    }

    const internalApps = ['electron', 'Electron'];
    const allowed = settings.allowedApps.includes(appName) || internalApps.includes(appName);

    if (allowed || isAppSnoozed(appName)) {
      if (!internalApps.includes(appName) && !isAppSnoozed(appName)) {
        focusSeconds++;
        maybeShowEncouragement();
      }
      hidePounce();
    } else {
      lastDetectedApp = appName;
      awaitingResponse = true;
      pounceCount++;
      playSound('pounce.wav');
      showScreen('pounce', { appName });
    }
  });
}

// ── IPC: pounce flow ──
ipcMain.on('pounce-done', () => showScreen('breakOffer'));
ipcMain.on('break-offer-yes', () => startBreak());
ipcMain.on('break-offer-no', () => showScreen('breakConfirm'));
ipcMain.on('break-confirm-yes', () => startBreak());
ipcMain.on('break-confirm-no', () => { awaitingResponse = false; hidePounce(); });

// NEW: snooze current distracting app
ipcMain.on('snooze-app', (event, { appName, minutes }) => {
  snoozeApp(appName || lastDetectedApp, minutes);
  awaitingResponse = false;
  hidePounce();
});

function startBreak() {
  onBreak = true;
  breakEndsAt = Date.now() + settings.breakDurationMin * 60 * 1000;
  breaksTaken++;
  awaitingResponse = false;
  hidePounce();
}

// ── IPC: data ──
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('get-session-stats', () => ({
  pounceCount,
  breaksTaken,
  sessionMinutes: Math.floor((Date.now() - sessionStart) / 60000),
  focusMinutes: Math.floor(focusSeconds / 60),
}));
ipcMain.handle('get-running-processes', () => new Promise((resolve) => {
  exec('powershell -command "Get-Process | Select-Object -ExpandProperty Name | Sort-Object -Unique"', (err, stdout) => {
    if (err) { resolve([]); return; }
    resolve(stdout.trim().split('\n').map(s => s.trim()).filter(Boolean));
  });
}));
ipcMain.on('close-report-card', () => { if (reportCardWindow) reportCardWindow.close(); });

ipcMain.on('save-settings', (event, newSettings) => {
  settings = { ...settings, ...newSettings };
  saveSettings(settings);
  if (peekWindow && !peekWindow.isDestroyed()) {
    peekWindow.webContents.send('set-pet', settings.pet);
  }
  rebuildTrayMenu();
});

// ── Tray menu builder (rebuilt on mute toggle) ──
function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => createDashboardWindow() },
    { label: 'Pause 60 min', click: () => {
      isPaused = true; pauseEndsAt = Date.now() + 60 * 60 * 1000; hidePounce();
    }},
    { label: 'Resume', click: () => { isPaused = false; } },
    { type: 'separator' },
    {
      label: settings.soundMuted ? '🔈 Unmute sounds' : '🔇 Mute sounds',
      click: () => {
        settings.soundMuted = !settings.soundMuted;
        saveSettings(settings);
        rebuildTrayMenu();
        if (dashboardWindow && !dashboardWindow.isDestroyed()) {
          dashboardWindow.webContents.send('mute-changed', settings.soundMuted);
        }
      }
    },
    { type: 'separator' },
    { label: 'Quit PawBack', click: () => app.quit() },
  ]));
}

// ── Weekly history helpers ──
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function recordDayHistory() {
  const key = todayKey();
  if (!settings.weeklyHistory) settings.weeklyHistory = {};
  settings.weeklyHistory[key] = {
    focusMinutes: Math.floor(focusSeconds / 60),
    pounceCount,
    breaksTaken,
  };
  // Keep only last 14 days
  const keys = Object.keys(settings.weeklyHistory).sort();
  while (keys.length > 14) {
    delete settings.weeklyHistory[keys.shift()];
  }
  saveSettings(settings);
}

app.whenReady().then(() => {
  app.setLoginItemSettings({ openAtLogin: true });

  createPeekWindow();
  createPounceWindow();
  setInterval(getActiveWindow, 1000);

  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('PawBack — locking you in 🐾');
  rebuildTrayMenu();
  tray.on('double-click', () => createDashboardWindow());

  globalShortcut.register('Control+Shift+P', () => {
    isPaused = true;
    pauseEndsAt = Date.now() + settings.pauseDurationMin * 60 * 1000;
    hidePounce();
  });
  globalShortcut.register('Control+Shift+R', () => {
    isPaused = false; onBreak = false; justFinishedBreak = false; hidePounce();
  });
  globalShortcut.register('Control+Shift+S', () => createDashboardWindow());

  let quitting = false;
  app.on('before-quit', (e) => {
    const today = todayKey();
    const last = settings.lastActiveDate;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (last === today) {}
    else if (last === yesterday) settings.streak = (settings.streak || 0) + 1;
    else settings.streak = 1;
    settings.lastActiveDate = today;
    recordDayHistory();

    if (!quitting && Math.floor((Date.now() - sessionStart) / 60000) >= 1) {
      e.preventDefault();
      reportCardWindow = new BrowserWindow({
        width: 480, height: 600, title: 'Session Wrapped', resizable: false,
        webPreferences: { preload: path.join(__dirname, 'preload.js') },
      });
      reportCardWindow.loadFile('reportcard.html');
      reportCardWindow.on('closed', () => { quitting = true; app.quit(); });
    }
  });
});