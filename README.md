# PawBack 🐾

A focus app that actually fights back. PawBack lives at the edge of your screen as a little peeking animal. The second you switch to something you shouldn't, it pounces and blocks your screen until you get back to work.

## Features

- 🐱 A pet that peeks from the corner of your screen while you're locked in
- 🚨 Full-screen takeover the moment you stray to a distraction app
- 💤 "Are you tired?" check-in after repeated slip-ups, with a real 10-minute break mode
- ✅ Allowed and blocked app list you control
- 🎭 Character selector (pick your guardian)
- 📊 Session stats showing how many times you got caught
- ⏰ Break timer that locks you back in when time's up

## Built With

- [Electron](https://www.electronjs.org/)
- [active-win](https://github.com/sindresorhus/active-win) for window detection
- HTML / CSS / JavaScript

## Getting Started

**You need Node.js installed.**

```bash
git clone https://github.com/shahmerrkhan/pawback.git
cd pawback
npm install
npm start
```

## How It Works

1. Launch PawBack
2. Add your allowed apps (VS Code, Notion, whatever you're working in)
3. Add your blocked apps (YouTube, Instagram, etc.)
4. Hit Lock In
5. Your pet appears at the edge of the screen
6. Switch to something blocked and it pounces, covering your whole screen
7. Get caught too many times and it asks if you need a break
8. After the break, it's right back to locking you in

## Roadmap

- [ ] Cursor-follow mode (pet sits on your cursor instead of full-screen takeover)
- [ ] Daily streak tracking
- [ ] Sound effects and audio reactions
- [ ] Custom lock-in messages
- [ ] Time-of-day moods (sleepy at night, hyper in the morning)
- [ ] Pomodoro-style break reminders even when you're focused

## License

MIT