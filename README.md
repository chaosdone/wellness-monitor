# WellnessLiving Slot Monitor

Monitors ReJenerate Pilates appointment availability for Jiyu Kim (Private Session 1:1) and alerts when new slots open up.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Edit `config.json` if needed (check interval, sound file, etc.)

## Usage

```
npm start
```

On first run, a Chrome window will open. If you're not logged in, the script will prompt you to log in manually in the browser window. Once logged in, the session is saved — future runs won't require login again.

The script will:
- Navigate to the appointment page every 2 minutes
- Toggle off waitlist-only slots
- Detect available time slots on the calendar
- Play a sound alert when new availability appears
- Log all findings to `logs/availability.log`
- Save a screenshot of each check to `logs/last-check.png`

## Stopping

Press `Ctrl+C` to stop the monitor.
