# Wellness Monitor

## Overview
Monitors WellnessLiving appointment and group class availability for Jiyu Kim at ReJenerate Pilates.
Uses Playwright (headless Chrome) to automate browser navigation and scrape the booking calendar/schedule.
Sends notifications via Telegram bot to all subscribers.

## Key Files
- `monitor.js` — Main script. Checks both Private Session appointments and Happy Hour group classes.
- `config.json` — Credentials, session dir, log file path, sound file.
- `subscribers.json` — List of Telegram chat IDs that receive notifications.
- `package.json` — Entry point is `npm start` → `node monitor.js`.
- `~/Library/LaunchAgents/com.czhou.wellness-monitor.plist` — launchd scheduled task.

## How It Works
1. Checks for new Telegram `/start` subscribers
2. **Private Session check**: Opens appointment page → logs in if needed → selects Private Session (1:1) → Jiyu Kim → scrapes calendar for available (non-waitlist) slots across 2 months
3. **Happy Hour check**: Opens schedule page → Group Class → Happy Hour All Level → scrapes Jiyu Kim's classes across 4 weeks, looking for availability > 0
4. Sends Telegram notification to all subscribers if any availability found
5. Retries each check once on failure (MAX_RETRIES = 2)

## Scheduling
- Runs via macOS launchd every hour at :05 (7:05am - 10:05pm PST)
- Manage: `launchctl unload/load ~/Library/LaunchAgents/com.czhou.wellness-monitor.plist`
- Manual trigger: `launchctl start com.czhou.wellness-monitor` or `node monitor.js`

## Telegram Bot
- Bot: @Jiyu_class_monitor_bot
- Token: stored in monitor.js (hardcoded default)
- Anyone can subscribe by sending `/start` to the bot
- Notifications sent to all subscribers every run if availability exists

## Config
- `MONTHS_TO_SCAN` env var controls appointment months to check (default: 2)
- `WEEKS_TO_SCAN` env var controls group class weeks to check (default: 4)
- Runs headless (no browser window)
- Logs: `logs/launchd-stdout.log`, `logs/availability.log` (cleared each run)
