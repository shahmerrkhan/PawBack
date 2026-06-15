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
      pet: 'penguin.png',
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
          content: `Generate 3 varied daily focus quests. Make them achievable but slightly challenging. For focus_minutes use targets between 20-60. For stay_under_pounces use targets between 2-5.${(settings.debtMinutes || 0) > 10 ? ' The user has carried over screen time debt so make focus_minutes targets 10-15 minutes harder than usual.' : ''}`
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
    else if (q.type === 'stay_under_pounces') newProgress = (((settings.weeklyHistory || {})[todayKey()] || {}).pounceCount || 0) + pounceCount;
    else if (q.type === 'no_break_streak')    newProgress = (((settings.weeklyHistory || {})[todayKey()] || {}).breaksTaken || 0) + breaksTaken;

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
function broadcastStats() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
  const key   = todayKey();
  const saved = (settings.weeklyHistory || {})[key] || { focusMinutes: 0, pounceCount: 0, breaksTaken: 0 };
  dashboardWindow.webContents.send('stats-update', {
    pounceCount:    saved.pounceCount  + pounceCount,
    breaksTaken:    saved.breaksTaken  + breaksTaken,
    sessionMinutes: Math.floor((Date.now() - sessionStart) / 60000),
    focusMinutes:   saved.focusMinutes + Math.floor(focusSeconds / 60),
  });
}

function broadcastQuestUpdate() {
  const payload = { quests: settings.quests, totalXP: settings.totalXP, level: settings.level };
  if (questboardWindow && !questboardWindow.isDestroyed()) questboardWindow.webContents.send('quest-update', payload);
  if (dashboardWindow  && !dashboardWindow.isDestroyed())  dashboardWindow.webContents.send('quest-update', payload);
}

// ── Session state ──
let peekWindow, pounceWindow, dashboardWindow, reportCardWindow, questboardWindow, timerWindow, tray;

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
let debtMinutes = 0;
let paybackActive = false;
let paybackEndsAt = null;
let paybackSeconds = 0;
// Focus Contracts
let activeContract = null; // { task, minutes, startedAt }
// Ghost Mode
let ghostTimeline = []; // yesterday's focus timeline loaded on startup
// App Heatmap — track which apps triggered pounces
let appPounceLog = {}; // { appName: count }
// Intervention Mode
let recentPounceWindow = []; // timestamps of recent pounces for spiral detection
let interventionFired = false;
// Pounce Replay — per-session minute log
let sessionReplay = []; // one entry per minute: 'focused'|'pounced'|'break'|'idle'

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
let pomodoroActive         = false;
let pomodoroEndsAt         = null;
let pomodoroBreakEndsAt    = null;
let pomodoroInBreak        = false;
let pomodoroRound          = 0;
let pomodoroPaused          = false;
let pomodoroPausedTimeLeft  = 0;
let pomodoroSessionEndFired = false;
let pomodoroBreakEndFired   = false;
let summaryShowing          = false;

let generalActive          = false;
let generalPaused          = false;
let generalSessionStart    = null;
let generalFocusSeconds    = 0;
let generalPounceCount     = 0;

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
  exec(`powershell -c (New-Object Media.SoundPlayer '${soundPath}').Play()`);
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
    width: 240, height: 210,
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

function createTimerWindow() {
  if (timerWindow && !timerWindow.isDestroyed()) { timerWindow.focus(); return; }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  timerWindow = new BrowserWindow({
    width: 220, height: 220,
    x: width - 340, y: height - 260,
    frame: false, transparent: false,
    alwaysOnTop: true, skipTaskbar: true,
    resizable: false, focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  timerWindow.loadFile('timer.html');
  timerWindow.on('closed', () => { timerWindow = null; });
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

const SUMMARY_SCREENS = ['pomodoroSessionEnd', 'pomodoroFinalSummary', 'generalSessionEnd'];

function showScreen(type, extra) {
  if (summaryShowing && !SUMMARY_SCREENS.includes(type)) return;
  const msg = type === 'pounce' ? lastAiMessage : '';
  pounceWindow.webContents.send('set-screen', type, settings.pet, msg, extra || null);
  if (!pounceWindow.isVisible()) {
    pounceWindow.show();
    pounceWindow.setAlwaysOnTop(true, 'screen-saver');
    pounceWindow.focus();
  }
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
  if (pomodoroActive && !pomodoroPaused) {
    if (!pomodoroInBreak && pomodoroEndsAt) {
      const left = Math.max(0, Math.floor((pomodoroEndsAt - now) / 1000));
      broadcastPomodoro(left);
      if (now >= pomodoroEndsAt && !pomodoroSessionEndFired) {
        pomodoroSessionEndFired = true;
        pomodoroInBreak     = true;
        pomodoroBreakEndsAt = null;
        playSound('lockin.wav');
        summaryShowing = true;
        showScreen('pomodoroSessionEnd', { round: pomodoroRound, breakMin: settings.pomodoroBreakMin || 5, workMin: settings.pomodoroWorkMin || 25, pounceCount });
        if (peekWindow && !peekWindow.isDestroyed())
          peekWindow.webContents.send('show-bubble', `Round ${pomodoroRound} done! 🍅 Break time!`);
        if (dashboardWindow && !dashboardWindow.isDestroyed())
          dashboardWindow.webContents.send('pomodoro-event', 'session-end');
      }
    } else if (pomodoroInBreak && pomodoroBreakEndsAt) {
      const left = Math.max(0, Math.floor((pomodoroBreakEndsAt - now) / 1000));
      broadcastPomodoro(left);
      if (now >= pomodoroBreakEndsAt && !pomodoroBreakEndFired) {
        pomodoroBreakEndFired   = true;
        pomodoroSessionEndFired = false;
        pomodoroInBreak = false;
        pomodoroRound++;
        pomodoroEndsAt  = Date.now() + (settings.pomodoroWorkMin || 25) * 60 * 1000;
        playSound('pounce.wav');
        broadcastMoodChange();
        inPomodoroCountdown = true;
        showScreen('pomodoroCountdown');
        setTimeout(() => {
          inPomodoroCountdown   = false;
          pomodoroBreakEndFired = false;
          hidePounce();
        }, 4000);
        if (peekWindow && !peekWindow.isDestroyed())
          peekWindow.webContents.send('show-bubble', `🍅 Round ${pomodoroRound} — lock in!`);
        if (dashboardWindow && !dashboardWindow.isDestroyed())
          dashboardWindow.webContents.send('pomodoro-event', 'break-end');
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
    sessionReplay.push(cell);
    if (focusTimeline.length > 480) focusTimeline.shift(); // max 8 hours
    if (dashboardWindow && !dashboardWindow.isDestroyed())
      dashboardWindow.webContents.send('timeline-update', focusTimeline);
  }

  // Payback sprint
  if (paybackActive) {
    if (Date.now() >= paybackEndsAt) {
      paybackActive = false;
      const carried = settings.debtMinutes || 0;
      settings.debtMinutes = 0;
      settings.totalXP = (settings.totalXP || 0) + 30;
      saveSettings(settings);
      broadcastQuestUpdate();
      adjustHealth(10);
      if (peekWindow && !peekWindow.isDestroyed())
        peekWindow.webContents.send('show-bubble', '✅ Debt cleared! Clean slate. +30 XP 🐾');
      if (dashboardWindow && !dashboardWindow.isDestroyed())
        dashboardWindow.webContents.send('debt-update', { debtMinutes: 0, paybackActive: false, secondsLeft: 0 });
    } else {
      paybackSeconds = Math.max(0, Math.floor((paybackEndsAt - Date.now()) / 1000));
      if (dashboardWindow && !dashboardWindow.isDestroyed())
        dashboardWindow.webContents.send('debt-update', { debtMinutes: settings.debtMinutes || 0, paybackActive: true, secondsLeft: paybackSeconds });
    }
    hidePounce();
    return;
  }

  if (!appName) return;
  
  // General session tracking
  if (generalActive && !generalPaused) {
    const allowed = settings.allowedApps || [];
    if (allowed.includes(currentAppName)) {
      generalFocusSeconds++;
    }
  }

  if (summaryShowing) return;

  if (isPaused) {
    if (now >= pauseEndsAt) {
      isPaused = false;
      if (peekWindow && !peekWindow.isDestroyed())
        peekWindow.webContents.send('mood-change', { mood: 'idle', health: petHealth, debt: 0 });
    }
    return;
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
        if (generalActive) generalPounceCount++;
    adjustHealth(-10);
    hourlyPounces[new Date().getHours()]++;
    pounceTimestamps.push(Date.now());
    debtMinutes++;
    appPounceLog[appName] = (appPounceLog[appName] || 0) + 1;
    recentPounceWindow.push(Date.now());
    recentPounceWindow = recentPounceWindow.filter(t => Date.now() - t < 20 * 60 * 1000);
    broadcastStats();
    updateQuestProgress();
    flushStatsToHistory();
    checkIntervention();
    playSound('pounce.wav');
    broadcastMoodChange();
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
      if (debtMinutes > 0) { debtMinutes = 0; broadcastMoodChange(); }
      if (focusSeconds % 60 === 0) { hourlyFocus[new Date().getHours()]++; broadcastStats(); }
      if (focusSeconds % 5 === 0) broadcastMoodChange();
      if (healthFocusCounter >= 60) {
        healthFocusCounter = 0;
        adjustHealth(2);
      }
      maybeShowEncouragement();
      checkActiveRecall();
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
    hourlyPounces[new Date().getHours()]++;
    pounceTimestamps.push(Date.now());
    debtMinutes++;
    appPounceLog[appName] = (appPounceLog[appName] || 0) + 1;
    recentPounceWindow.push(Date.now());
    recentPounceWindow = recentPounceWindow.filter(t => Date.now() - t < 20 * 60 * 1000);
    broadcastStats();
    updateQuestProgress();
    flushStatsToHistory();
    checkIntervention();
    playSound('pounce.wav');
    broadcastMoodChange();
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
  if (summaryShowing) return;
  if (bossMode || lastBlockedPounce) {
    lastBlockedPounce = false;
    showScreen('bossPounce', { allowedApps: settings.allowedApps });
  } else {
    showScreen('breakOffer');
  }
});

ipcMain.on('break-offer-yes',   () => { if (summaryShowing) return; startBreak(); });
ipcMain.on('break-offer-no',    () => { if (summaryShowing) return; showScreen('breakConfirm'); });
ipcMain.on('break-confirm-yes', () => { if (summaryShowing) return; startBreak(); });
ipcMain.on('break-confirm-no',  () => { if (summaryShowing) return; awaitingResponse = false; hidePounce(); });

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
  broadcastStats();
  updateQuestProgress();
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
  settings.pomodoroWorkMin    = workMin;
  settings.pomodoroBreakMin   = breakMin;
  pomodoroRound               = 0;
  pomodoroSessionEndFired     = false;
  pomodoroBreakEndFired       = false;

  inPomodoroCountdown = true;
  showScreen('pomodoroCountdown');
  setTimeout(() => {
    inPomodoroCountdown = false;
    hidePounce();
    startPomodoro(workMin);
    const target = settings.allowedApps[0];
    if (target) switchToApp(target);
  }, 4000);
});

ipcMain.on('general-start', () => {
  generalActive       = true;
  generalPaused       = false;
  generalSessionStart = Date.now();
  generalFocusSeconds = 0;
  generalPounceCount  = 0;
  inPomodoroCountdown = true;
  showScreen('pomodoroCountdown');
  setTimeout(() => {
    inPomodoroCountdown = false;
    hidePounce();
  }, 4000);
});

ipcMain.on('general-pause', () => {
  generalPaused = true;
});

ipcMain.on('general-resume', () => {
  generalPaused = false;
});

ipcMain.on('general-stop', () => {
  if (!generalActive) return;
  generalActive = false;
  generalPaused = false;
  const totalMin    = Math.floor((Date.now() - generalSessionStart) / 60000);
  const focusMin    = Math.floor(generalFocusSeconds / 60);
  const distractMin = Math.max(0, totalMin - focusMin);
  summaryShowing = true;
  showScreen('generalSessionEnd', {
    totalMin,
    focusMin,
    distractMin,
    pounceCount: generalPounceCount,
  });
});

ipcMain.on('general-ack-end', () => {
  summaryShowing = false;
  hidePounce();
});

ipcMain.on('pomodoro-ack-session-end', () => {
  summaryShowing = false;
  hidePounce();
  pomodoroBreakEndsAt = Date.now() + (settings.pomodoroBreakMin || 5) * 60 * 1000;
});

ipcMain.on('pomodoro-ack-final', () => {
  summaryShowing = false;
  hidePounce();
});

ipcMain.on('pomodoro-stop', () => {
  const roundsDone = pomodoroRound;
  const totalFocusMin = roundsDone * (settings.pomodoroWorkMin || 25);
  pomodoroActive          = false;
  pomodoroInBreak         = false;
  pomodoroPaused          = false;
  pomodoroPausedTimeLeft  = 0;
  pomodoroSessionEndFired = false;
  pomodoroBreakEndFired   = false;
  inPomodoroCountdown     = false;
  if (peekWindow      && !peekWindow.isDestroyed())      peekWindow.webContents.send('pomodoro-tick', null);
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('pomodoro-tick', null);
  if (roundsDone > 0) {
    summaryShowing = true;
    showScreen('pomodoroFinalSummary', {
      rounds:       roundsDone,
      totalFocusMin,
      pounceCount,
      breakMin:     settings.pomodoroBreakMin || 5,
    });
  }
});

ipcMain.on('pomodoro-pause', () => {
  if (!pomodoroActive || pomodoroPaused) return;
  pomodoroPaused = true;
  const now = Date.now();
  pomodoroPausedTimeLeft = pomodoroInBreak
    ? Math.max(0, pomodoroBreakEndsAt - now)
    : Math.max(0, pomodoroEndsAt - now);
  const secondsLeft = Math.floor(pomodoroPausedTimeLeft / 1000);
  const data = { secondsLeft, inBreak: pomodoroInBreak, round: pomodoroRound, paused: true };
  if (peekWindow      && !peekWindow.isDestroyed())      peekWindow.webContents.send('pomodoro-tick', data);
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('pomodoro-tick', data);
});

ipcMain.on('pomodoro-resume', () => {
  if (!pomodoroActive || !pomodoroPaused) return;
  pomodoroPaused = false;
  const now = Date.now();
  if (pomodoroInBreak) {
    pomodoroBreakEndsAt = now + pomodoroPausedTimeLeft;
  } else {
    pomodoroEndsAt = now + pomodoroPausedTimeLeft;
  }
  pomodoroPausedTimeLeft = 0;
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

ipcMain.on('start-payback', () => {
  if (debtMinutes > 0) {
    paybackActive = true;
    paybackSeconds = debtMinutes * 60;
    paybackEndsAt = Date.now() + paybackSeconds * 1000;
    broadcastMoodChange();
    if (peekWindow && !peekWindow.isDestroyed())
      peekWindow.webContents.send('show-bubble', `🔥 PAYBACK TIME! You owe ${debtMinutes} min. No breaks until it's paid!`);
  }
});

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
ipcMain.handle('get-hover-message', async (event, context) => {
  const tone = effectiveTone();
  const task = activeContract ? activeContract.task : null;
  const prompt = tone === 'brutal'
    ? `You are a brutally honest cat mascot sitting in the corner of the user's screen. They just hovered over you. Say something short and slightly mean. Max 7 words. No quotes.${task ? ` They're supposed to be studying: ${task}.` : ''}`
    : tone === 'gentle'
    ? `You are a sweet cat mascot sitting in the corner of the user's screen. They just hovered over you. Say something cute and warm. Max 7 words. No quotes.${task ? ` They're studying: ${task}.` : ''}`
    : `You are a sassy cat mascot sitting in the corner of the user's screen. They just hovered over you. Say something witty and playful. Max 7 words. No quotes.${task ? ` They're supposed to be studying: ${task}.` : ''}`;
  const msg = await groqRequest({
    model: 'llama3-8b-8192',
    max_tokens: 30,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: 'Say something.' },
    ],
  });
  return msg || null;
});
ipcMain.on('open-questboard',    () => createQuestboardWindow());
ipcMain.handle('get-quests',     () => ({ quests: settings.quests, totalXP: settings.totalXP, level: settings.level }));
ipcMain.handle('get-timeline',   () => focusTimeline);
ipcMain.handle('get-persona',    () => computePersona());
ipcMain.handle('get-focus-dna',    () => getFocusDna());
ipcMain.handle('get-app-heatmap',  () => computeAppHeatmap());
ipcMain.handle('get-contract',     () => getContractStatus());
ipcMain.handle('get-ghost',        () => ({ ghostTimeline, sessionReplay }));
ipcMain.handle('get-replay',       () => sessionReplay);
ipcMain.on('start-contract', (event, { task, minutes }) => startContract(task, minutes));
ipcMain.on('quick-contract', (event, { task }) => {
  const minutes = settings.pomodoroWorkMin || 25;
  startContract(task, minutes);
  if (peekWindow && !peekWindow.isDestroyed())
    peekWindow.webContents.send('show-bubble', `📝 locked in: ${task}`);
});
ipcMain.on('end-contract',   () => {
  if (!activeContract) return;
  const status = getContractStatus();
  const focusedMin = Math.min(status.elapsed, status.minutes);
  if (!settings.subjectLog) settings.subjectLog = {};
  const key = todayKey();
  if (!settings.subjectLog[key]) settings.subjectLog[key] = {};
  const subj = activeContract.task;
  settings.subjectLog[key][subj] = (settings.subjectLog[key][subj] || 0) + focusedMin;
  activeContract = null;
  settings.contractsTotal    = (settings.contractsTotal    || 0) + 1;
  settings.contractsKept     = (settings.contractsKept     || 0) + (status.done && !status.broken ? 1 : 0);
  saveSettings(settings);
  if (dashboardWindow && !dashboardWindow.isDestroyed())
    dashboardWindow.webContents.send('contract-update', null);
});
ipcMain.on('intervention-response', (event, choice) => {
  interventionFired = false;
  if (choice === 'overwhelmed') {
    startBreak();
    if (peekWindow && !peekWindow.isDestroyed())
      peekWindow.webContents.send('show-bubble', `take a breath. come back when you're ready 🐾`);
  } else if (choice === 'tired') {
    startBreak();
    if (peekWindow && !peekWindow.isDestroyed())
      peekWindow.webContents.send('show-bubble', `rest up. we go again after ☕`);
  } else {
    awaitingResponse = false;
    hidePounce();
    if (peekWindow && !peekWindow.isDestroyed())
      peekWindow.webContents.send('show-bubble', `let's go. locked in 🔒`);
  }
});
ipcMain.handle('get-subject-log', () => {
  const key = todayKey();
  return (settings.subjectLog || {})[key] || {};
});
ipcMain.handle('get-debt', () => ({
  debtMinutes:   (settings.debtMinutes || 0) + debtMinutes,
  paybackActive,
  secondsLeft:   paybackActive ? Math.max(0, Math.floor((paybackEndsAt - Date.now()) / 1000)) : 0,
}));
ipcMain.on('start-payback', () => {
  const total = (settings.debtMinutes || 0) + debtMinutes;
  if (total <= 0) return;
  paybackActive  = true;
  paybackEndsAt  = Date.now() + total * 60 * 1000;
  debtMinutes    = 0;
  settings.debtMinutes = 0;
  saveSettings(settings);
  if (peekWindow && !peekWindow.isDestroyed())
    peekWindow.webContents.send('show-bubble', `🔒 Payback started — ${total} min. No escape.`);
  if (dashboardWindow && !dashboardWindow.isDestroyed())
    dashboardWindow.webContents.send('debt-update', { debtMinutes: total, paybackActive: true, secondsLeft: total * 60 });
});
ipcMain.on('skip-payback', () => {
  const total = (settings.debtMinutes || 0) + debtMinutes;
  settings.debtMinutes = total;
  debtMinutes = 0;
  saveSettings(settings);
  if (peekWindow && !peekWindow.isDestroyed())
    peekWindow.webContents.send('show-bubble', `😒 debt carried over. tomorrow's quests will be harder.`);
});
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

ipcMain.on('open-timer',  () => createTimerWindow());
ipcMain.on('close-timer', () => { if (timerWindow && !timerWindow.isDestroyed()) timerWindow.close(); });
ipcMain.on('move-timer-window', (_, x, y) => { if (timerWindow && !timerWindow.isDestroyed()) timerWindow.setPosition(Math.round(x), Math.round(y)); });
ipcMain.on('timer-buzz', () => {
  exec(`powershell -c "[console]::beep(880,200); Start-Sleep -Milliseconds 100; [console]::beep(880,200)"`);
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
    { label: '⏱ Question Timer', click: () => createTimerWindow() },
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

// ── Focus DNA — predictive engine ──
let focusDnaWarningFired = {};  // track which warnings fired today so they don't repeat

function getFocusDna() {
  const history = settings.weeklyHistory || {};
  const days = Object.keys(history).sort().slice(-14);
  if (days.length < 2) return null;

  // Average pounces per hour across all history
  const avgHourlyPounces = new Array(24).fill(0);
  const avgHourlyFocus   = new Array(24).fill(0);
  let dayCounts = 0;
  days.forEach(d => {
    const hp = history[d].hourlyPounces || [];
    const hf = history[d].hourlyFocus   || [];
    hp.forEach((v, i) => avgHourlyPounces[i] += v);
    hf.forEach((v, i) => avgHourlyFocus[i]   += v);
    dayCounts++;
  });
  if (dayCounts > 0) {
    avgHourlyPounces.forEach((_, i) => avgHourlyPounces[i] /= dayCounts);
    avgHourlyFocus.forEach((_,   i) => avgHourlyFocus[i]   /= dayCounts);
  }

  // Average session length before focus collapses (pounce after long focus)
  const focusCollapseMinutes = [];
  days.forEach(d => {
    const fm = history[d].focusMinutes || 0;
    const pc = history[d].pounceCount  || 0;
    if (pc > 0 && fm > 0) focusCollapseMinutes.push(fm / pc);
  });
  const avgCollapseAt = focusCollapseMinutes.length
    ? Math.round(focusCollapseMinutes.reduce((a, b) => a + b, 0) / focusCollapseMinutes.length)
    : null;

  // Worst day of week
  const dowPounces = {};
  days.forEach(d => {
    const dow = new Date(d).getDay();
    if (!dowPounces[dow]) dowPounces[dow] = { total: 0, count: 0 };
    dowPounces[dow].total += history[d].pounceCount || 0;
    dowPounces[dow].count++;
  });
  let worstDow = null, worstAvg = 0;
  Object.entries(dowPounces).forEach(([dow, v]) => {
    const avg = v.total / v.count;
    if (avg > worstAvg) { worstAvg = avg; worstDow = Number(dow); }
  });

  return { avgHourlyPounces, avgHourlyFocus, avgCollapseAt, worstDow, worstAvg };
}

function runFocusDna() {
  const dna = getFocusDna();
  if (!dna) return;

  const now      = new Date();
  const hour     = now.getHours();
  const todayDow = now.getDay();
  const todayStr = todayKey();
  const focusMin = Math.floor(focusSeconds / 60) + ((settings.weeklyHistory[todayStr] || {}).focusMinutes || 0);

  // 1. Pre-emptive danger hour warning — if this hour is historically bad, warn at :55 of previous hour
  const nextHour = (hour + 1) % 24;
  const warningKey = `danger-${todayStr}-${nextHour}`;
  if (
    dna.avgHourlyPounces[nextHour] >= 1.5 &&
    now.getMinutes() >= 55 &&
    !focusDnaWarningFired[warningKey]
  ) {
    focusDnaWarningFired[warningKey] = true;
    const label = `${nextHour > 12 ? nextHour - 12 : nextHour === 0 ? 12 : nextHour}${nextHour >= 12 ? 'pm' : 'am'}`;
    if (peekWindow && !peekWindow.isDestroyed())
      peekWindow.webContents.send('show-bubble', `⚠️ heads up — you usually drift around ${label}. stay locked.`);
  }

  // 2. Focus collapse warning — warn before they historically fall apart
  if (dna.avgCollapseAt && !onBreak && !awaitingResponse) {
    const collapseWarningKey = `collapse-${todayStr}-${Math.floor(focusMin / 5)}`;
    if (
      focusMin >= dna.avgCollapseAt - 3 &&
      focusMin < dna.avgCollapseAt + 3 &&
      !focusDnaWarningFired[collapseWarningKey]
    ) {
      focusDnaWarningFired[collapseWarningKey] = true;
      if (peekWindow && !peekWindow.isDestroyed())
        peekWindow.webContents.send('show-bubble', `🧠 you usually drift around now. push through — ${dna.avgCollapseAt + 5} min is your real target.`);
    }
  }

  // 3. Worst day of week heads-up — fire once at session start on their worst day
  const worstDayKey = `worstday-${todayStr}`;
  if (
    todayDow === dna.worstDow &&
    dna.worstAvg >= 2 &&
    !focusDnaWarningFired[worstDayKey] &&
    Math.floor((Date.now() - sessionStart) / 60000) < 5
  ) {
    focusDnaWarningFired[worstDayKey] = true;
    const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][todayDow];
    if (peekWindow && !peekWindow.isDestroyed())
      peekWindow.webContents.send('show-bubble', `👀 ${dayName}s are historically your worst day. prove it wrong.`);
  }

  // 4. Third pounce intervention — change tone entirely instead of roasting again
  const tripleKey = `triple-${todayStr}`;
  const totalPounces = ((settings.weeklyHistory[todayStr] || {}).pounceCount || 0) + pounceCount;
  if (totalPounces === 3 && !focusDnaWarningFired[tripleKey] && awaitingResponse) {
    focusDnaWarningFired[tripleKey] = true;
    setTimeout(() => {
      if (peekWindow && !peekWindow.isDestroyed())
        peekWindow.webContents.send('show-bubble', `okay. let's reset. close everything. breathe. then we go again 🐾`);
    }, 500);
  }
}
  
// ── Active Recall ──
let activeRecallMin = 0;
let activeRecallNextAt = null;

ipcMain.on('start-recall-mode', (event, { intervalMin }) => {
  activeRecallMin = intervalMin || 20;
  activeRecallNextAt = Date.now() + activeRecallMin * 60 * 1000;
  if (peekWindow && !peekWindow.isDestroyed())
    peekWindow.webContents.send('show-bubble', `🧠 Recall mode on — every ${activeRecallMin} min I'll ask you to close your notes.`);
});

ipcMain.on('stop-recall-mode', () => {
  activeRecallMin = 0;
  activeRecallNextAt = null;
});

function checkActiveRecall() {
  if (!activeRecallMin || !activeRecallNextAt) return;
  if (Date.now() < activeRecallNextAt) return;
  activeRecallNextAt = Date.now() + activeRecallMin * 60 * 1000;
  if (peekWindow && !peekWindow.isDestroyed())
    peekWindow.webContents.send('recall-prompt');
}

// ── Intervention Mode ──
function checkIntervention() {
  if (interventionFired) return;
  if (recentPounceWindow.length >= 5) {
    interventionFired = true;
    setTimeout(() => {
      showScreen('intervention');
    }, 800);
  }
}

// ── Focus Contracts ──
function startContract(task, minutes) {
  activeContract = { task, minutes, startedAt: Date.now() };
  if (peekWindow && !peekWindow.isDestroyed())
    peekWindow.webContents.send('show-bubble', `📝 Contract started — ${task} for ${minutes} min. Don't break it.`);
  if (dashboardWindow && !dashboardWindow.isDestroyed())
    dashboardWindow.webContents.send('contract-update', getContractStatus());
}

function getContractStatus() {
  if (!activeContract) return null;
  const elapsed = Math.floor((Date.now() - activeContract.startedAt) / 60000);
  const done    = elapsed >= activeContract.minutes;
  const todayPounces = ((settings.weeklyHistory[todayKey()] || {}).pounceCount || 0) + pounceCount;
  const broken  = todayPounces > 3 && !done;
  return { ...activeContract, elapsed, done, broken };
}

function computeAppHeatmap() {
  const history = settings.weeklyHistory || {};
  const combined = { ...appPounceLog };
  // also fold in saved stray reasons from history (using app-level pounce log)
  Object.values(history).forEach(day => {
    if (day.appPounceLog) {
      Object.entries(day.appPounceLog).forEach(([app, count]) => {
        combined[app] = (combined[app] || 0) + count;
      });
    }
  });
  return Object.entries(combined)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([app, count]) => ({ app, count }));
}

function computeCatMood() {
  if (paybackActive) return 'angry';
  if (onBreak) return 'party';
  if (awaitingResponse) return 'angry';
  if (focusSeconds > 0 && !awaitingResponse) return 'focused';
  return 'idle';
}

function broadcastMoodChange() {
  const mood = computeCatMood();
  const health = settings.petHealth ?? 70;
  const debt = paybackActive ? Math.ceil(paybackSeconds / 60) : (debtMinutes > 0 ? debtMinutes : 0);
  if (peekWindow && !peekWindow.isDestroyed())
    peekWindow.webContents.send('mood-change', { mood, health, debt: debt > 0 ? debt : 0 });
  }

function flushStatsToHistory() {
  const key = todayKey();
  if (!settings.weeklyHistory) settings.weeklyHistory = {};
  const existing = settings.weeklyHistory[key] || { focusMinutes: 0, pounceCount: 0, breaksTaken: 0 };
  const existingHF = existing.hourlyFocus   || new Array(24).fill(0);
  const existingHP = existing.hourlyPounces || new Array(24).fill(0);
  const addedMinutes = Math.floor(focusSeconds / 60);
  const existingLog = existing.appPounceLog || {};
  Object.entries(appPounceLog).forEach(([app, count]) => {
    existingLog[app] = (existingLog[app] || 0) + count;
  });
  settings.weeklyHistory[key] = {
    focusMinutes:    existing.focusMinutes + addedMinutes,
    pounceCount:     existing.pounceCount  + pounceCount,
    breaksTaken:     existing.breaksTaken  + breaksTaken,
    reasons:         existing.reasons || {},
    hourlyFocus:     existingHF.map((v, i) => v + hourlyFocus[i]),
    hourlyPounces:   existingHP.map((v, i) => v + hourlyPounces[i]),
    appPounceLog:    existingLog,
    replayTimeline:  sessionReplay,
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
  setInterval(() => {
    const today     = todayKey();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (settings.lastActiveDate !== today) {
      if (settings.lastActiveDate === yesterday) settings.streak = (settings.streak || 0) + 1;
      else if (settings.lastActiveDate !== '') settings.streak = 1;
      settings.lastActiveDate = today;
      saveSettings(settings);
    }
  }, 60 * 60 * 1000);
  setInterval(updateQuestProgress, 10000);
  setInterval(() => {
    const h = new Date().getHours();
    const m = new Date().getMinutes();
    if (h === 22 && m === 0) {
      const key = todayKey();
      const saved = (settings.weeklyHistory[key] || { focusMinutes: 0 });
      const total = saved.focusMinutes + Math.floor(focusSeconds / 60);
      const streak = settings.streak || 0;
      if (peekWindow && !peekWindow.isDestroyed())
        peekWindow.webContents.send('show-bubble', `📊 today: ${total} min focused · ${streak} day streak 🔥`);
    }
  }, 60 * 1000);
  setInterval(runFocusDna, 60 * 1000);

  // Load yesterday's timeline for ghost mode
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  ghostTimeline = (settings.weeklyHistory[yesterday] || {}).replayTimeline || [];
  generateDailyQuests();

  // Save streak on startup so crashes don't wipe it
  const _today = todayKey();
  const _yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  // streak is handled entirely on quit — don't touch it on startup
  
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
    const totalDebt = (settings.debtMinutes || 0) + debtMinutes;
    sessionSnapshot = {
      pounceCount:    saved.pounceCount,
      breaksTaken:    saved.breaksTaken,
      sessionMinutes: Math.floor((Date.now() - sessionStart) / 60000),
      focusMinutes:   saved.focusMinutes,
      debtMinutes:    totalDebt,
    };
    // carry debt forward if not paid
    settings.debtMinutes = totalDebt;
    saveSettings(settings);

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