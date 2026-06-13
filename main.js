require('dotenv').config();
const { app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Settings ──
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
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
      pomodoroWorkMin: 25,
      pomodoroBreakMin: 5,
      blockedApps: [],
      bossMode: false,
    };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

let settings = loadSettings();
if (!settings.pounceTone)               settings.pounceTone = 'sassy';
if (settings.soundMuted === undefined)  settings.soundMuted = false;
if (!settings.weeklyHistory)            settings.weeklyHistory = {};
if (!settings.blockedApps)             settings.blockedApps = [];

// ── Persistent PowerShell for fast window detection ──
let psProcess = null;
let currentAppName = '';
let psBuffer = '';

const activeWin = require('active-win');

function startSwitchPS() {
  psProcess = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  psProcess.on('exit', () => setTimeout(startSwitchPS, 1000));
  const setup = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WF {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
`;
  psProcess.stdin.write(setup + '\n');
}
startSwitchPS();

function startPersistentPS() {
  setInterval(async () => {
    try {
      const win = await activeWin();
      if (win && win.owner && win.owner.path) {
        currentAppName = path.basename(win.owner.path, '.exe');
        console.log('ACTIVE:', JSON.stringify(currentAppName));
      }
    } catch (e) {
      console.log('activeWin error:', e);
    }
  }, 800);
}

startPersistentPS();

// ── AI messages ──
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
  sassy:  'You are a sassy but cute cat mascot for a focus app. The user wanders off from their work — roast them gently. ONE short funny message, max 10 words, no quotes, end with an emoji maybe. Be playful not mean.',
  brutal: "You are a brutal, no-nonsense drill-sergeant cat mascot. The user left their work. Give ONE harsh, blunt, slightly mean message to send them back, max 10 words. No coddling. No emoji unless it's 💀 or 😤.",
};

const encouragementLevels = [
  ["You're doing great, keep going!", "Look at you, locked in 💪", "Future you says thanks"],
  ["On a roll! Don't stop now 🔥", "8 minutes of pure focus. Legend.", "The cat is proud of you 🐾"],
  ["You're in the zone. Don't break it.", "16+ minutes locked in. Absolute beast.", "This is what discipline looks like 💪🔥"],
  ["You are UNSTOPPABLE. Keep going!! 🚀", "30 mins? The cat bows to you. 🙇", "Machine. Absolute machine. 🔥🔥🔥"],
];

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const { desktopCapturer } = require('electron');

async function captureScreenBase64() {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1024, height: 640 } });
    if (!sources.length) return null;
    return sources[0].thumbnail.toJPEG(70).toString('base64');
  } catch {
    return null;
  }
}

async function groqVisionRoast(imageBase64, appName, tone) {
  const visionPrompt = {
    gentle: "You're a sweet cat mascot. Look at this screenshot of what the user is doing instead of working. Give ONE warm, gentle callout referencing what you actually SEE on screen, max 14 words, with a soft emoji.",
    sassy:  "You're a sassy cat mascot. Look at this screenshot of what the user is doing instead of working. Roast them playfully based on what you SEE on screen specifically — be specific, not generic. Max 14 words, no quotes.",
    brutal: "You're a brutal drill-sergeant cat. Look at this screenshot of what the user is doing instead of working. Call out EXACTLY what you see on screen, bluntly and harshly. Max 14 words.",
  };
  try {
    const result = await groqRequest({
      model: 'llama-3.2-11b-vision-preview',
      max_tokens: 60,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: visionPrompt[tone] || visionPrompt.sassy },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
          ]
        }
      ],
    });
    return result;
  } catch {
    return null;
  }
}
let lastAiMessage = fallbackMessages.sassy[0];
let pounceCount = 0;

function effectiveTone() {
  const base = settings.pounceTone || 'sassy';
  if (pounceCount >= 5) return 'brutal';
  if (pounceCount >= 2 && base === 'gentle') return 'sassy';
  return base;
}

function randomFallback() {
  const msgs = fallbackMessages[effectiveTone()];
  return msgs[Math.floor(Math.random() * msgs.length)];
}

async function groqRequest(body) {
  const https = require('https');
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).choices?.[0]?.message?.content?.trim() || null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
    req.write(bodyStr);
    req.end();
  });
}

async function fetchAiMessage() {
  try {
    const tone = effectiveTone();
    const msg = await groqRequest({
      model: 'llama3-8b-8192',
      max_tokens: 60,
      messages: [
        { role: 'system', content: toneSystemPrompts[tone] },
        { role: 'user', content: `User just switched away from work. Pounce count today: ${pounceCount}. Give me a new message.` },
      ],
    });
    lastAiMessage = msg || randomFallback();
  } catch {
    lastAiMessage = randomFallback();
  }
}

async function fetchEncouragement(bucket) {
  const fallbacks = encouragementLevels[Math.min(bucket, encouragementLevels.length - 1)];
  try {
    const hype = bucket >= 3 ? 'extremely hype and excited' : bucket >= 2 ? 'enthusiastic' : 'warm and supportive';
    const msg = await groqRequest({
      model: 'llama3-8b-8192',
      max_tokens: 30,
      messages: [
        { role: 'system', content: `You are a cute pet mascot for a focus app. The user has been focused for a while. Be ${hype}. Give ONE short encouragement, max 8 words, with an emoji. No quotes.` },
        { role: 'user', content: 'Encourage the user.' },
      ],
    });
    return msg || fallbacks[Math.floor(Math.random() * fallbacks.length)];
  } catch {
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

fetchAiMessage();

// ── Session state ──
let peekWindow, pounceWindow, dashboardWindow, reportCardWindow, tray;

const sessionStart = Date.now();
let breaksTaken    = 0;
let focusSeconds   = 0;
let sessionSnapshot = null;

let onBreak          = false;
let breakEndsAt      = null;
let justFinishedBreak = false;
let isPaused         = false;
let pauseEndsAt      = null;
let awaitingResponse = false;
let lastBlockedPounce = false;
let lastDetectedApp  = '';
let explorerSince    = null;
let lastEncouragementAt = 0;
let strayReasons = {};
let inPomodoroCountdown = false;

if (settings.petHealth === undefined) settings.petHealth = 70;
let petHealth = settings.petHealth;
let healthFocusCounter = 0;

function adjustHealth(delta) {
  petHealth = Math.max(0, Math.min(100, petHealth + delta));
  settings.petHealth = petHealth;
  broadcastHealth();
}

function broadcastHealth() {
  if (peekWindow      && !peekWindow.isDestroyed())      peekWindow.webContents.send('pet-health', petHealth);
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('pet-health', petHealth);
}

let bossMode = settings.bossMode || false;

// ── Pomodoro ──
let pomodoroActive     = false;
let pomodoroEndsAt     = null;
let pomodoroBreakEndsAt = null;
let pomodoroInBreak    = false;
let pomodoroRound      = 0;

function startPomodoro(workMin) {
  pomodoroActive   = true;
  pomodoroInBreak  = false;
  pomodoroRound++;
  pomodoroEndsAt   = Date.now() + workMin * 60 * 1000;
  broadcastPomodoro(workMin * 60);
}

function broadcastPomodoro(secondsLeft) {
  const data = { secondsLeft, inBreak: pomodoroInBreak, round: pomodoroRound };
  if (peekWindow      && !peekWindow.isDestroyed())      peekWindow.webContents.send('pomodoro-tick', data);
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('pomodoro-tick', data);
}

// ── App snooze ──
let snoozedApps = {};

function isAppSnoozed(appName) {
  if (!snoozedApps[appName]) return false;
  if (Date.now() >= snoozedApps[appName]) { delete snoozedApps[appName]; return false; }
  return true;
}

function snoozeApp(appName, minutes) {
  snoozedApps[appName] = Date.now() + minutes * 60 * 1000;
}

// ── Sound ──
function playSound(file) {
  if (settings.soundMuted) return;
  const soundPath = path.join(__dirname, 'sounds', file);
  exec(`powershell -c (New-Object Media.SoundPlayer '${soundPath}').PlaySync()`);
}

// ── Encouragement ──
async function maybeShowEncouragement() {
  const now = Date.now();
  if (focusSeconds > 0 && focusSeconds % (8 * 60) === 0 && now - lastEncouragementAt > 60000) {
    lastEncouragementAt = now;
    const bucket = Math.floor(focusSeconds / (8 * 60)) - 1;
    const msg = await fetchEncouragement(bucket);
    if (peekWindow && !peekWindow.isDestroyed()) peekWindow.webContents.send('show-bubble', msg);
  }
}

// ── Windows ──
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
    resizable: false, show: false, focusable: true,
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
}

function showScreen(type, extra) {
  const msg = type === 'pounce' ? lastAiMessage : '';
  pounceWindow.webContents.send('set-screen', type, settings.pet, msg, extra || null);
  if (!pounceWindow.isVisible()) pounceWindow.show();
  pounceWindow.setAlwaysOnTop(true, 'screen-saver');
  pounceWindow.focus();
  if (type === 'pounce') {
    if (peekWindow && !peekWindow.isDestroyed()) peekWindow.webContents.send('pounce-active', true);
  }
}

function hidePounce() {
  if (pounceWindow && pounceWindow.isVisible()) pounceWindow.hide();
  awaitingResponse = false;
  updatePeekMood();
  if (peekWindow && !peekWindow.isDestroyed()) peekWindow.webContents.send('pounce-active', false);
}

function updatePeekMood() {
  let mood = 'happy';
  if      (pounceCount >= 6) mood = 'done';
  else if (pounceCount >= 3) mood = 'suspicious';
  if (peekWindow && !peekWindow.isDestroyed()) peekWindow.webContents.send('set-mood', mood);
}

// ── Tick ──
function tick() {
  if (inPomodoroCountdown) return;
  const appName = currentAppName;
  const now = Date.now();

  // Pomodoro ticking
  if (pomodoroActive) {
    if (!pomodoroInBreak && pomodoroEndsAt) {
      const left = Math.max(0, Math.floor((pomodoroEndsAt - now) / 1000));
      broadcastPomodoro(left);
      if (now >= pomodoroEndsAt) {
        pomodoroInBreak     = true;
        pomodoroBreakEndsAt = Date.now() + (settings.pomodoroBreakMin || 5) * 60 * 1000;
        playSound('lockin.wav');
        if (peekWindow && !peekWindow.isDestroyed())
          peekWindow.webContents.send('show-bubble', `Round ${pomodoroRound} done! 🍅 Break time!`);
      }
    } else if (pomodoroInBreak && pomodoroBreakEndsAt) {
      const left = Math.max(0, Math.floor((pomodoroBreakEndsAt - now) / 1000));
      broadcastPomodoro(left);
      if (now >= pomodoroBreakEndsAt) {
        pomodoroInBreak = false;
        pomodoroRound++;
        pomodoroEndsAt  = Date.now() + (settings.pomodoroWorkMin || 25) * 60 * 1000;
        playSound('pounce.wav');
        if (peekWindow && !peekWindow.isDestroyed())
          peekWindow.webContents.send('show-bubble', `🍅 Round ${pomodoroRound} — lock in!`);
      }
    }
  }

  if (!appName) return;

  if (isPaused) {
    if (now >= pauseEndsAt) isPaused = false;
    else { hidePounce(); return; }
  }

  if (onBreak) {
    if (now >= breakEndsAt) {
      onBreak           = false;
      justFinishedBreak = true;
      playSound('lockin.wav');
      showScreen('lockin');
    } else { hidePounce(); }
    return;
  }

  if (justFinishedBreak) {
    if (settings.allowedApps.includes(appName)) { justFinishedBreak = false; hidePounce(); }
    return;
  }

  if (awaitingResponse) {
    if (settings.allowedApps.includes(appName)) { awaitingResponse = false; hidePounce(); }
    return;
  }

  const internalApps = ['electron', 'Electron'];
  const isBlocked    = (settings.blockedApps || []).includes(appName);
  const allowed      = settings.allowedApps.includes(appName) || internalApps.includes(appName);

  if (isBlocked && !awaitingResponse) {
    if (lastDetectedApp !== appName) {
      lastDetectedApp = appName;
      explorerSince = now;
      return;
    }
    if (now - explorerSince < 10000) return;

    awaitingResponse  = true;
    lastBlockedPounce = true;
    pounceCount++;
    adjustHealth(-10);
    playSound('pounce.wav');
    if (peekWindow && !peekWindow.isDestroyed()) peekWindow.webContents.send('pre-pounce');

    (async () => {
      const img = await captureScreenBase64();
      if (img) {
        const roast = await groqVisionRoast(img, appName, effectiveTone());
        if (roast) lastAiMessage = roast;
      }
      showScreen('pounce', { appName, blocked: true });
    })();
    return;
  }

  if (allowed || isAppSnoozed(appName)) {
    if (!internalApps.includes(appName) && !isAppSnoozed(appName)) {
      focusSeconds++;
      healthFocusCounter++;
      if (healthFocusCounter >= 60) {
        healthFocusCounter = 0;
        adjustHealth(2);
      }
      maybeShowEncouragement();
    }
    lastDetectedApp = '';
    hidePounce();
  } else {
    if (lastDetectedApp !== appName) {
      lastDetectedApp = appName;
      explorerSince = now;
      return;
    }
    if (now - explorerSince < 10000) return;

    awaitingResponse = true;
    pounceCount++;
    adjustHealth(-6);
    playSound('pounce.wav');
    if (peekWindow && !peekWindow.isDestroyed()) peekWindow.webContents.send('pre-pounce');

    (async () => {
      const img = await captureScreenBase64();
      if (img) {
        const roast = await groqVisionRoast(img, appName, effectiveTone());
        if (roast) lastAiMessage = roast;
      }
      setTimeout(() => showScreen('pounce', { appName }), 400);
    })();
  }
}

// ── IPC handlers ──
ipcMain.on('pounce-done', () => {
  if (bossMode || lastBlockedPounce) {
    lastBlockedPounce = false;
    showScreen('bossPounce', { allowedApps: settings.allowedApps });
  } else {
    showScreen('breakOffer');
  }
});

ipcMain.on('break-offer-yes',   () => startBreak());
ipcMain.on('break-offer-no',    () => showScreen('breakConfirm'));
ipcMain.on('break-confirm-yes', () => startBreak());
ipcMain.on('break-confirm-no',  () => { awaitingResponse = false; hidePounce(); });

ipcMain.on('log-stray-reason', (event, reason) => {
  strayReasons[reason] = (strayReasons[reason] || 0) + 1;
  if (!settings.weeklyHistory) settings.weeklyHistory = {};
  const key = todayKey();
  if (!settings.weeklyHistory[key]) settings.weeklyHistory[key] = { focusMinutes: 0, pounceCount: 0, breaksTaken: 0 };
  if (!settings.weeklyHistory[key].reasons) settings.weeklyHistory[key].reasons = {};
  settings.weeklyHistory[key].reasons[reason] = (settings.weeklyHistory[key].reasons[reason] || 0) + 1;
  saveSettings(settings);
});

function startBreak() {
  onBreak          = true;
  breakEndsAt      = Date.now() + settings.breakDurationMin * 60 * 1000;
  breaksTaken++;
  awaitingResponse = false;
  hidePounce();
}

function switchToApp(appName) {
  const script = `
$p = Get-Process -Name '${appName}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  [WF]::ShowWindow($p.MainWindowHandle, 9)
  [WF]::SetForegroundWindow($p.MainWindowHandle)
}
`;
  if (psProcess && psProcess.stdin.writable) {
    psProcess.stdin.write(script + '\n');
  }
}

ipcMain.on('switch-to-app', (event, appName) => {
  switchToApp(appName);
  lastDetectedApp  = '';
  awaitingResponse = false;
  hidePounce();
});

ipcMain.on('toggle-boss-mode', () => {
  bossMode          = !bossMode;
  settings.bossMode = bossMode;
  saveSettings(settings);
  rebuildTrayMenu();
  if (dashboardWindow && !dashboardWindow.isDestroyed())
    dashboardWindow.webContents.send('boss-mode-changed', bossMode);
});
ipcMain.handle('get-boss-mode', () => bossMode);

ipcMain.on('pomodoro-start', (event, { workMin, breakMin }) => {
  settings.pomodoroWorkMin  = workMin;
  settings.pomodoroBreakMin = breakMin;
  pomodoroRound = 0;

  inPomodoroCountdown = true;
  showScreen('pomodoroCountdown');
  setTimeout(() => {
    inPomodoroCountdown = false;
    hidePounce();
    startPomodoro(workMin);
    const target = settings.allowedApps[0];
    if (target) switchToApp(target);
  }, 3000);
});

ipcMain.on('pomodoro-stop', () => {
  pomodoroActive  = false;
  pomodoroInBreak = false;
  if (peekWindow      && !peekWindow.isDestroyed())      peekWindow.webContents.send('pomodoro-tick', null);
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('pomodoro-tick', null);
});

ipcMain.on('snooze-app', (event, { appName, minutes }) => {
  snoozeApp(appName || lastDetectedApp, minutes);
  lastDetectedApp  = '';
  awaitingResponse = false;
  hidePounce();
});

ipcMain.handle('get-settings',      () => ({ ...settings, petHealth }));
ipcMain.handle('get-session-stats', () => sessionSnapshot || {
  pounceCount,
  breaksTaken,
  sessionMinutes: Math.floor((Date.now() - sessionStart) / 60000),
  focusMinutes:   Math.floor(focusSeconds / 60),
});


ipcMain.handle('get-running-processes', () => new Promise((resolve) => {
  const cmd = `
$running = Get-Process | Group-Object Name | ForEach-Object { $_.Group[0] } | Select-Object Name, Description
$paths = @(
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:AppData\\Microsoft\\Windows\\Start Menu\\Programs"
)
$installed = foreach ($base in $paths) {
  Get-ChildItem -Path $base -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    $sh = New-Object -ComObject WScript.Shell
    $target = $sh.CreateShortcut($_.FullName).TargetPath
    if ($target -and $target -match '\\.exe$') {
      $name = [System.IO.Path]::GetFileNameWithoutExtension($target)
      $desc = (Get-Item $target -ErrorAction SilentlyContinue).VersionInfo.FileDescription
      [PSCustomObject]@{ Name = $name; Description = if ($desc) { $desc } else { [System.IO.Path]::GetFileNameWithoutExtension($_.Name) } }
    }
  }
}
$all = @($running) + @($installed)
$all | Group-Object Name | ForEach-Object { $_.Group[0] } | Select-Object Name, Description | ConvertTo-Json -Compress
`;
  const enc = Buffer.from(cmd, 'utf16le').toString('base64');
  exec(`powershell -EncodedCommand ${enc}`, { maxBuffer: 1024 * 1024 * 8 }, (err, stdout) => {
    if (err) { resolve([]); return; }
    try {
      let data = JSON.parse(stdout);
      if (!Array.isArray(data)) data = [data];
      const seen = new Set();
      const out = [];
      for (const p of data) {
        if (!p.Name || seen.has(p.Name)) continue;
        seen.add(p.Name);
        out.push({ proc: p.Name, friendly: p.Description || p.Name });
      }
      resolve(out);
    } catch {
      resolve([]);
    }
  });
}));

ipcMain.on('close-report-card', () => { if (reportCardWindow) reportCardWindow.close(); });
ipcMain.on('open-dashboard',    () => createDashboardWindow());

ipcMain.on('save-settings', (event, newSettings) => {
  settings = { ...settings, ...newSettings };
  saveSettings(settings);
  if (peekWindow && !peekWindow.isDestroyed()) peekWindow.webContents.send('set-pet', settings.pet);
  rebuildTrayMenu();
});

// ── Tray ──
function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => createDashboardWindow() },
    { label: `Pause ${settings.pauseDurationMin || 60} min`, click: () => {
        isPaused    = true;
        pauseEndsAt = Date.now() + (settings.pauseDurationMin || 60) * 60 * 1000;
        hidePounce();
    }},
    { label: 'Resume', click: () => {
        isPaused          = false;
        onBreak           = false;
        justFinishedBreak = false;
        lastDetectedApp   = '';
        hidePounce();
    }},
    { type: 'separator' },
    { label: bossMode ? '😤 Boss Mode: ON' : '💀 Boss Mode: OFF', click: () => {
        bossMode          = !bossMode;
        settings.bossMode = bossMode;
        saveSettings(settings);
        rebuildTrayMenu();
    }},
    { label: settings.soundMuted ? '🔈 Unmute sounds' : '🔇 Mute sounds', click: () => {
        settings.soundMuted = !settings.soundMuted;
        saveSettings(settings);
        rebuildTrayMenu();
        if (dashboardWindow && !dashboardWindow.isDestroyed())
          dashboardWindow.webContents.send('mute-changed', settings.soundMuted);
    }},
    { type: 'separator' },
    { label: 'Quit PawBack', click: () => app.quit() },
  ]));
}

// ── History ──
function todayKey() { return new Date().toISOString().slice(0, 10); }

function recordDayHistory() {
  saveSettings(settings);
  const key      = todayKey();
  if (!settings.weeklyHistory) settings.weeklyHistory = {};
  const existing = settings.weeklyHistory[key] || { focusMinutes: 0, pounceCount: 0, breaksTaken: 0 };
  settings.weeklyHistory[key] = {
    focusMinutes: existing.focusMinutes + Math.floor(focusSeconds / 60),
    pounceCount:  existing.pounceCount  + pounceCount,
    breaksTaken:  existing.breaksTaken  + breaksTaken,
  };
  focusSeconds = 0;
  pounceCount  = 0;
  breaksTaken  = 0;
  const keys = Object.keys(settings.weeklyHistory).sort();
  while (keys.length > 14) delete settings.weeklyHistory[keys.shift()];
  saveSettings(settings);
}

// ── App ready ──
app.whenReady().then(() => {
  app.setLoginItemSettings({ openAtLogin: true });
  app.on('window-all-closed', (e) => e.preventDefault());

  createPeekWindow();
  createPounceWindow();

  setInterval(tick, 1000);
  setInterval(recordDayHistory, 5 * 60 * 1000);

  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('PawBack — locking you in 🐾');
  rebuildTrayMenu();
  tray.on('double-click', () => createDashboardWindow());

  globalShortcut.register('Control+Shift+P', () => {
    isPaused    = true;
    pauseEndsAt = Date.now() + settings.pauseDurationMin * 60 * 1000;
    hidePounce();
  });
  globalShortcut.register('Control+Shift+R', () => {
    isPaused          = false;
    onBreak           = false;
    justFinishedBreak = false;
    lastDetectedApp   = '';
    hidePounce();
  });
  globalShortcut.register('Control+Shift+S', () => createDashboardWindow());

  let quitting = false;
  app.on('before-quit', (e) => {
    const today     = todayKey();
    const last      = settings.lastActiveDate;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    if      (last === today)      { /* streak continues */ }
    else if (last === yesterday)  settings.streak = (settings.streak || 0) + 1;
    else                          settings.streak = 1;
    settings.lastActiveDate = today;

    sessionSnapshot = {
      pounceCount,
      breaksTaken,
      sessionMinutes: Math.floor((Date.now() - sessionStart) / 60000),
      focusMinutes:   Math.floor(focusSeconds / 60),
    };
    recordDayHistory();

    if (!quitting && sessionSnapshot.sessionMinutes >= 1) {
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