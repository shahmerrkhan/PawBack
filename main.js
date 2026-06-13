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
  } catch (e) {
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
        catch (e) { resolve(null); }
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
  } catch (e) {
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

// ── Daily Quests ──
const QUEST_FALLBACKS = [
  { id: 'q1', type: 'focus_minutes',      text: 'Stay focused for 30 minutes',     target: 30,  progress: 0, done: false },
  { id: 'q2', type: 'stay_under_pounces', text: 'Keep pounces under 3 today',       target: 3,   progress: 0, done: false },
  { id: 'q3', type: 'no_break_streak',    text: 'Take zero unplanned breaks today', target: 0,   progress: 0, done: false },
];

async function generateDailyQuests() {
  const today = todayKey();
  if (settings.questDate === today && settings.quests && settings.quests.length === 3) return;

  // Reset progress for new day
  settings.questDate = today;
  let quests = null;

  try {
    const raw = await groqRequest({
      model: 'llama3-8b-8192',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `You generate daily focus quests for a productivity cat app. Return ONLY a JSON array of exactly 3 quest objects with these fields: id (q1/q2/q3), type (one of: focus_minutes, stay_under_pounces, no_break_streak), text (short fun quest description under 10 words), target (number: minutes for focus_minutes, max pounces for stay_under_pounces, 0 for no_break_streak). No markdown, no explanation, just the raw JSON array.`
        },
        {
          role: 'user',
          content: `Generate 3 varied daily focus quests. Make them achievable but slightly challenging. For focus_minutes use targets between 20-60. For stay_under_pounces use targets between 2-5.`
        }
      ],
    });
    if (raw) {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.length === 3) {
        quests = parsed.map((q, i) => ({ ...q, id: `q${i+1}`, progress: 0, done: false }));
      }
    }
    } catch (e) { /* fall through to fallback */ }
    
  settings.quests = quests || QUEST_FALLBACKS.map(q => ({ ...q, progress: 0, done: false }));
  saveSettings(settings);
}

function updateQuestProgress() {
  if (!settings.quests || !settings.quests.length) return;
  let changed = false;

  settings.quests.forEach(q => {
    if (q.done) return;
    let newProgress = q.progress;

    if      (q.type === 'focus_minutes')      newProgress = (((settings.weeklyHistory || {})[todayKey()] || {}).focusMinutes || 0) + Math.floor(focusSeconds / 60);
    else if (q.type === 'stay_under_pounces') newProgress = pounceCount;
    else if (q.type === 'no_break_streak')    newProgress = breaksTaken;

    if (newProgress !== q.progress) { q.progress = newProgress; changed = true; }

    // Check completion
    let completed = false;
    if      (q.type === 'focus_minutes')      completed = q.progress >= q.target;
    else if (q.type === 'stay_under_pounces') completed = false; // checked at end of day
    else if (q.type === 'no_break_streak')    completed = false; // checked at end of day

    if (completed && !q.done) {
      q.done = true;
      changed = true;
      awardQuestXP(q);
    }
  });

  if (changed) {
    saveSettings(settings);
    broadcastQuestUpdate();
  }
}

function checkEndOfDayQuests() {
  if (!settings.quests || !settings.quests.length) return;
  settings.quests.forEach(q => {
    if (q.done) return;
    if (q.type === 'stay_under_pounces' && pounceCount <= q.target) {
      q.done = true;
      awardQuestXP(q);
    }
    if (q.type === 'no_break_streak' && breaksTaken === 0) {
      q.done = true;
      awardQuestXP(q);
    }
  });
  saveSettings(settings);
}

function awardQuestXP(quest) {
  settings.totalXP = (settings.totalXP || 0) + 50;
  const newLevel = Math.floor(settings.totalXP / 200) + 1;
  const leveledUp = newLevel > (settings.level || 1);
  settings.level = newLevel;
  adjustHealth(5);
  saveSettings(settings);

  const msg = leveledUp
    ? `Quest done! Level up! Now Level ${settings.level} 🎉`
    : `Quest complete! +50 XP 🐾`;
  if (peekWindow && !peekWindow.isDestroyed()) peekWindow.webContents.send('show-bubble', msg);
  broadcastQuestUpdate();
}

function broadcastQuestUpdate() {
  const payload = { quests: settings.quests, totalXP: settings.totalXP, level: settings.level };
  if (questboardWindow && !questboardWindow.isDestroyed()) questboardWindow.webContents.send('quest-update', payload);
  if (dashboardWindow  && !dashboardWindow.isDestroyed())  dashboardWindow.webContents.send('quest-update', payload);
}

// ── Session state ──
let peekWindow, pounceWindow, dashboardWindow, reportCardWindow, questboardWindow, tray;

const sessionStart = Date.now();
let breaksTaken    = 0;
let focusSeconds   = 0;
let sessionSnapshot = null;
// clear any stale snapshot from previous run

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
let lastMoodCheckAt = 0;
let moodLog = []; // { time, mood } entries this session
let hourlyFocus   = new Array(24).fill(0); // minutes focused per hour of day
let hourlyPounces = new Array(24).fill(0); // pounces per hour of day
let pounceTimestamps = []; // ms timestamps of each pounce this session
let focusTimeline = []; // one entry per minute: 'focused' | 'pounced' | 'on-break' | 'idle'
let timelineMinuteCounter = 0;

if (settings.petHealth === undefined) settings.petHealth = 70;
if (settings.totalXP   === undefined) settings.totalXP   = 0;
if (settings.level     === undefined) settings.level     = 1;
if (!settings.questDate)              settings.questDate  = '';
if (!settings.quests)                 settings.quests     = [];
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
  // Mood check-in every 30 min of focus
  if (focusSeconds > 0 && focusSeconds % (30 * 60) === 0 && now - lastMoodCheckAt > 60000) {
    lastMoodCheckAt = now;
    if (peekWindow && !peekWindow.isDestroyed()) peekWindow.webContents.send('mood-checkin');
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
    resizable: false, focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  peekWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  peekWindow.webContents.session.on('will-download', (e) => e.preventDefault());
  if (settings.peekX !== undefined && settings.peekY !== undefined) {
    peekWindow.setPosition(settings.peekX, settings.peekY);
  }
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

function createQuestboardWindow() {
  if (questboardWindow && !questboardWindow.isDestroyed()) { questboardWindow.focus(); return; }
  questboardWindow = new BrowserWindow({
    width: 520, height: 620, title: 'Daily Quests',
    resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  questboardWindow.loadFile('questboard.html');
  questboardWindow.on('closed', () => { questboardWindow = null; });
}

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    if (dashboardWindow.isMinimized()) dashboardWindow.restore();
    dashboardWindow.focus();
    return;
  }
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

  // Timeline: record once per 60 ticks (1 min)
  timelineMinuteCounter++;
  if (timelineMinuteCounter >= 60) {
    timelineMinuteCounter = 0;
    let cell = 'idle';
    if (onBreak)                                        cell = 'on-break';
    else if (awaitingResponse)                          cell = 'pounced';
    else if (settings.allowedApps.includes(appName))   cell = 'focused';
    focusTimeline.push(cell);
    if (focusTimeline.length > 480) focusTimeline.shift(); // max 8 hours
    if (dashboardWindow && !dashboardWindow.isDestroyed())
      dashboardWindow.webContents.send('timeline-update', focusTimeline);
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
    flushStatsToHistory();
    hourlyPounces[new Date().getHours()]++;
    pounceTimestamps.push(Date.now());
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
      if (focusSeconds % 60 === 0) hourlyFocus[new Date().getHours()]++;
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
    flushStatsToHistory();
    hourlyPounces[new Date().getHours()]++;
    pounceTimestamps.push(Date.now());
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
  flushStatsToHistory();
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
ipcMain.handle('get-session-stats', () => {
  const key = todayKey();
  const saved = (settings.weeklyHistory || {})[key] || { focusMinutes: 0, pounceCount: 0, breaksTaken: 0 };
  return sessionSnapshot || {
    pounceCount:    saved.pounceCount  + pounceCount,
    breaksTaken:    saved.breaksTaken  + breaksTaken,
    sessionMinutes: Math.floor((Date.now() - sessionStart) / 60000),
    focusMinutes:   saved.focusMinutes + Math.floor(focusSeconds / 60),
  };
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
    } catch (e) {
      resolve([]);
    }
  });
}));

ipcMain.on('close-report-card',  () => { if (reportCardWindow) reportCardWindow.close(); });

ipcMain.on('mood-response', async (event, mood) => {
  const entry = { time: new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }), mood };
  moodLog.push(entry);

  // Log to today's history
  const key = todayKey();
  if (!settings.weeklyHistory[key]) settings.weeklyHistory[key] = { focusMinutes: 0, pounceCount: 0, breaksTaken: 0 };
  if (!settings.weeklyHistory[key].moods) settings.weeklyHistory[key].moods = [];
  settings.weeklyHistory[key].moods.push(entry);
  saveSettings(settings);

  // Respond based on mood
  const responses = {
    '💪': ['Absolute beast mode. Keep going. 🔥', 'Nothing can stop you right now 🚀', 'This is what locked in looks like 💪'],
    '😊': ['Good vibes only, keep it up! 🌟', 'Happy cat, happy you 🐾', 'Smooth sailing ✨'],
    '😴': null, // triggers break offer
    '😤': ['Breathe. You got this. 💙', 'Channel that energy into the work 💪', 'Stressed but still here? That\'s strength 🐾'],
  };

  if (mood === '😴') {
    // suggest a break
    if (peekWindow && !peekWindow.isDestroyed()) peekWindow.webContents.send('show-bubble', 'You seem tired — maybe take a short break? 😴');
  } else {
    const pool = responses[mood];
    if (pool) {
      const msg = pool[Math.floor(Math.random() * pool.length)];
      // try groq for a personalised response
      const ai = await groqRequest({
        model: 'llama3-8b-8192', max_tokens: 40,
        messages: [
          { role: 'system', content: `You are a cute cat mascot. The user said they feel ${mood}. Respond in ONE short encouraging sentence, max 10 words, with an emoji. No quotes.` },
          { role: 'user', content: 'React to my mood.' },
        ],
      });
      if (peekWindow && !peekWindow.isDestroyed()) peekWindow.webContents.send('show-bubble', ai || msg);
    }
  }

  // Broadcast updated mood log to dashboard
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('mood-update', moodLog);
});

ipcMain.handle('get-mood-log', () => moodLog);
ipcMain.on('open-questboard',    () => createQuestboardWindow());
ipcMain.handle('get-quests',     () => ({ quests: settings.quests, totalXP: settings.totalXP, level: settings.level }));
ipcMain.handle('get-timeline',   () => focusTimeline);
ipcMain.handle('get-persona',    () => computePersona());
ipcMain.on('open-dashboard',    () => createDashboardWindow());

ipcMain.on('save-peek-position', (event, { x, y }) => {
  if (peekWindow && !peekWindow.isDestroyed()) peekWindow.setPosition(x, y);
  settings.peekX = x;
  settings.peekY = y;
  saveSettings(settings);
});
ipcMain.handle('get-window-position', () => {
  const pos = peekWindow && !peekWindow.isDestroyed() ? peekWindow.getPosition() : [0, 0];
  return { x: pos[0], y: pos[1] };
});

ipcMain.on('move-peek-window', (event, { x, y }) => {
  if (peekWindow && !peekWindow.isDestroyed()) peekWindow.setPosition(x, y);
});

ipcMain.on('save-peek-position', (event, { x, y }) => {
  if (peekWindow && !peekWindow.isDestroyed()) peekWindow.setPosition(x, y);
  settings.peekX = x;
  settings.peekY = y;
  saveSettings(settings);
});

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
    { label: '🐾 Daily Quests', click: () => createQuestboardWindow() },
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

function computePersona() {
  const history = settings.weeklyHistory || {};
  const days = Object.keys(history).sort();
  if (days.length === 0) return null;

  const traits = [];

  // 1. Time-of-day identity — peak focus hour from hourlyFocus
  const peakHour = hourlyFocus.indexOf(Math.max(...hourlyFocus));
  const totalFocusTracked = hourlyFocus.reduce((a, b) => a + b, 0);
  if (totalFocusTracked >= 5) {
    if (peakHour >= 22 || peakHour <= 3)
      traits.push({ label: 'Night Owl', emoji: '🦉', desc: `You lock in hardest after ${peakHour > 12 ? peakHour - 12 : peakHour}${peakHour >= 12 ? 'pm' : 'am'}` });
    else if (peakHour >= 5 && peakHour <= 9)
      traits.push({ label: 'Early Bird', emoji: '🌅', desc: `You crush it before ${peakHour + 1 > 12 ? peakHour + 1 - 12 : peakHour + 1}am` });
    else if (peakHour >= 10 && peakHour <= 14)
      traits.push({ label: 'Midday Machine', emoji: '☀️', desc: `Your peak window is around ${peakHour > 12 ? peakHour - 12 : peakHour}${peakHour >= 12 ? 'pm' : 'am'}` });
    else
      traits.push({ label: 'Afternoon Grinder', emoji: '🌆', desc: `You hit your stride in the late afternoon` });
  }

  // 2. Consistency — how many of the last 7 days had focus data
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    last7.push(history[d]?.focusMinutes || 0);
  }
  const activeDays = last7.filter(m => m > 0).length;
  if (activeDays >= 6)
    traits.push({ label: 'Iron Streak', emoji: '🔥', desc: `${activeDays}/7 days active this week` });
  else if (activeDays >= 4)
    traits.push({ label: 'Steady Grinder', emoji: '⚙️', desc: `${activeDays}/7 days active — building momentum` });
  else if (activeDays <= 2 && days.length >= 3)
    traits.push({ label: 'Comeback Pending', emoji: '💤', desc: `Only ${activeDays} active days — time to lock in` });

  // 3. Pounce recovery — average time between pounce and returning to focus
  // estimated by total session time vs focus time ratio
  const todayData = history[todayKey()] || {};
  const todayPounces = (todayData.pounceCount || 0) + pounceCount;
  const todayFocus   = (todayData.focusMinutes || 0) + Math.floor(focusSeconds / 60);
  const sessionMin   = Math.floor((Date.now() - sessionStart) / 60000);
  if (todayPounces > 0 && sessionMin > 10) {
    const focusRatio = todayFocus / Math.max(sessionMin, 1);
    if (focusRatio >= 0.85)
      traits.push({ label: 'Comeback Kid', emoji: '💪', desc: `${Math.round(focusRatio * 100)}% of session was focused — barely slowed down` });
    else if (focusRatio < 0.4)
      traits.push({ label: 'Distraction Magnet', emoji: '🧲', desc: `Only ${Math.round(focusRatio * 100)}% focused today — the cat is judging you` });
  }

  // 4. Volume — total weekly focus
  const weeklyTotal = last7.reduce((a, b) => a + b, 0);
  if (weeklyTotal >= 600)
    traits.push({ label: 'Focus Beast', emoji: '🏆', desc: `${Math.round(weeklyTotal / 60)}h focused this week` });
  else if (weeklyTotal >= 200)
    traits.push({ label: 'Solid Worker', emoji: '📚', desc: `${weeklyTotal} min focused this week` });

  // 5. Worst day of week
  const dayTotals = {};
  days.forEach(d => {
    const dow = new Date(d).toLocaleDateString('en', { weekday: 'long' });
    if (!dayTotals[dow]) dayTotals[dow] = { focus: 0, pounces: 0, count: 0 };
    dayTotals[dow].focus   += history[d].focusMinutes || 0;
    dayTotals[dow].pounces += history[d].pounceCount  || 0;
    dayTotals[dow].count++;
  });
  const dowEntries = Object.entries(dayTotals).filter(([, v]) => v.count >= 2);
  if (dowEntries.length >= 2) {
    const worst = dowEntries.sort((a, b) => (b[1].pounces / b[1].count) - (a[1].pounces / a[1].count))[0];
    const best  = dowEntries.sort((a, b) => (b[1].focus  / b[1].count) - (a[1].focus  / a[1].count))[0];
    if (worst[0] !== best[0]) {
      traits.push({ label: `${worst[0]} Menace`, emoji: '😈', desc: `${worst[0]}s are your most distracted day` });
      traits.push({ label: `${best[0]} Warrior`, emoji: '⚔️', desc: `${best[0]}s are when you focus best` });
    }
  }

  // 6. Hourly danger zone — worst pounce hour
  const worstPounceHour = hourlyPounces.indexOf(Math.max(...hourlyPounces));
  const maxPounces = Math.max(...hourlyPounces);
  if (maxPounces >= 2) {
    const h = worstPounceHour;
    const label = `${h > 12 ? h - 12 : h === 0 ? 12 : h}${h >= 12 ? 'pm' : 'am'}`;
    traits.push({ label: 'Danger Zone', emoji: '⚠️', desc: `You drift most around ${label}` });
  }

  return { traits: traits.slice(0, 4), weeklyTotal, activeDays };
}


function flushStatsToHistory() {
  const key = todayKey();
  if (!settings.weeklyHistory) settings.weeklyHistory = {};
  const existing = settings.weeklyHistory[key] || { focusMinutes: 0, pounceCount: 0, breaksTaken: 0 };
  const existingHF = existing.hourlyFocus   || new Array(24).fill(0);
  const existingHP = existing.hourlyPounces || new Array(24).fill(0);
  const addedMinutes = Math.floor(focusSeconds / 60);
  settings.weeklyHistory[key] = {
    focusMinutes:  existing.focusMinutes + addedMinutes,
    pounceCount:   existing.pounceCount  + pounceCount,
    breaksTaken:   existing.breaksTaken  + breaksTaken,
    reasons:       existing.reasons || {},
    hourlyFocus:   existingHF.map((v, i) => v + hourlyFocus[i]),
    hourlyPounces: existingHP.map((v, i) => v + hourlyPounces[i]),
  };
  focusSeconds -= addedMinutes * 60;
  pounceCount = 0;
  breaksTaken = 0;
  hourlyFocus   = new Array(24).fill(0);
  hourlyPounces = new Array(24).fill(0);
  saveSettings(settings);
}

function recordDayHistory() {
  // flushStatsToHistory already saved focusSeconds/pounceCount/breaksTaken
  // this function just trims old history and saves
  const keys = Object.keys(settings.weeklyHistory || {}).sort();
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
  setInterval(flushStatsToHistory, 5 * 60 * 1000);
  setInterval(updateQuestProgress, 10000);
  generateDailyQuests();

  // Save streak on startup so crashes don't wipe it
  const _today = todayKey();
  const _yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (settings.lastActiveDate !== _today) {
    if (settings.lastActiveDate === _yesterday) settings.streak = (settings.streak || 0) + 1;
    else if (settings.lastActiveDate !== '') settings.streak = 0;
    // don't set lastActiveDate here — set it on quit so streak only counts if you actually used it
    saveSettings(settings);
  }
  
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
  globalShortcut.register('Control+Shift+Q', () => createQuestboardWindow());
  
  let quitting = false;
  app.on('before-quit', (e) => {
    const today     = todayKey();
    const last      = settings.lastActiveDate;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    if (last !== today) {
      if (last === yesterday) settings.streak = (settings.streak || 0) + 1;
      else settings.streak = 1;
      settings.lastActiveDate = today;
    }

    // flush everything to history first
    flushStatsToHistory();

    const key = todayKey();
    const saved = (settings.weeklyHistory || {})[key] || { focusMinutes: 0, pounceCount: 0, breaksTaken: 0 };
    sessionSnapshot = {
      pounceCount:    saved.pounceCount,
      breaksTaken:    saved.breaksTaken,
      sessionMinutes: Math.floor((Date.now() - sessionStart) / 60000),
      focusMinutes:   saved.focusMinutes,
    };

    checkEndOfDayQuests();
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