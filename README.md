PawBack
A focus guardian app that actually has personality. PawBack lives on the edge of your screen as a little peeking animal. The moment you switch to a distraction app, it pounces and takes over your screen until you get back to work.
What it does

Sits quietly at the corner of your screen while you're focused
Detects when you switch to a non-allowed app and covers your screen
Asks if you need a break after repeated slip-ups (and actually lets you take one)
Forces you back in after the break is over
Lets you set which apps are allowed vs blocked
Supports multiple animal characters to choose from
Tracks how many times you got caught per session

Built with

Electron
Node.js
active-win (window detection)
HTML/CSS/JS for all UI

Getting started
Prerequisites: Node.js installed
bashgit clone https://github.com/shahmerrkhan/pawback.git
cd pawback
npm install
npm start
How to use

Launch the app
Set your allowed apps (e.g. VS Code, your browser with docs)
Set your blocked apps (YouTube, Instagram, etc.)
Hit Lock In
Your pet appears. Stay focused or face the consequences.

Features

Allowed/blocked app list
Break mode with a countdown timer
"Are you tired?" check-in after repeated distractions
Character selector
Session stats (how many times you got caught)
Peek overlay that stays out of your way when you're locked in

Roadmap

 Sounds and audio reactions
 Daily streak tracking
 Custom lock-in messages
 Cursor-follow mode (pet blocks your cursor instead of full screen)
 Pomodoro-style built-in break reminders
 Time-of-day moods (sleepy at night, hyper in the morning)

License
MIT