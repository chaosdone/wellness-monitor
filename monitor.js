process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Support env vars (for Railway) or config.json (for local)
const configPath = path.resolve(__dirname, 'config.json');
const config = fs.existsSync(configPath) ? require(configPath) : {};

const IS_CLOUD = process.env.RAILWAY_ENVIRONMENT || process.env.IS_CLOUD || false;
const CRED_EMAIL = process.env.WL_EMAIL || config.credentials?.email;
const CRED_PASSWORD = process.env.WL_PASSWORD || config.credentials?.password;

const SESSION_DIR = path.resolve(__dirname, config.sessionDir || '.chrome-session');
const LOG_FILE = path.resolve(__dirname, config.logFile || 'logs/availability.log');
const START_URL = 'https://www.wellnessliving.com/rs/appointment-new/rejenerate_pilates';
const SCHEDULE_URL = 'https://www.wellnessliving.com/schedule/rejenerate_pilates';
const WEEKS_TO_SCAN = parseInt(process.env.WEEKS_TO_SCAN || '4');


function log(message) {
  const timestamp = new Date().toLocaleString('en-CA', { timeZone: 'America/Vancouver' });
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function playSound() {
  if (IS_CLOUD) return; // No sound in cloud
  try {
    execSync(`afplay "${config.soundFile || '/System/Library/Sounds/Glass.aiff'}"`, { stdio: 'ignore' });
  } catch {
    console.error('Failed to play sound');
  }
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || config.telegramToken;
const SUBSCRIBERS_FILE = path.resolve(__dirname, 'subscribers.json');

function loadSubscribers() {
  try {
    return JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8'));
  } catch {
    return [7997281464];
  }
}

function saveSubscribers(subscribers) {
  fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([...new Set(subscribers)], null, 2));
}

async function checkNewSubscribers() {
  const offsetFile = path.resolve(__dirname, 'logs/telegram-offset.json');
  let offset = 0;
  try {
    offset = JSON.parse(fs.readFileSync(offsetFile, 'utf8')).offset || 0;
  } catch {}

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=0`);
    const data = await res.json();
    if (!data.ok) return;

    const subscribers = loadSubscribers();
    for (const update of data.result) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (msg && msg.text === '/start') {
        const chatId = msg.chat.id;
        if (!subscribers.includes(chatId)) {
          subscribers.push(chatId);
          log(`New subscriber: ${msg.chat.first_name || ''} ${msg.chat.last_name || ''} (${chatId})`);
          await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: '✅ 已订阅 Jiyu Kim 课程通知！有空位时会自动通知你。' }),
          });
        }
      }
    }
    saveSubscribers(subscribers);
    fs.writeFileSync(offsetFile, JSON.stringify({ offset }));
  } catch (err) {
    log(`Telegram getUpdates error: ${err.message}`);
  }
}

async function sendTelegram(message) {
  const subscribers = loadSubscribers();
  for (const chatId of subscribers) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      });
      const data = await res.json();
      if (!data.ok) log(`Telegram error (${chatId}): ${JSON.stringify(data)}`);
    } catch (err) {
      log(`Telegram error (${chatId}): ${err.message}`);
    }
  }
  log(`Telegram message sent to ${subscribers.length} subscriber(s)`);
}

async function sendNotification(message) {
  log(`NOTIFICATION: ${message}`);
  await sendTelegram(message);
}

// Navigate from Step 1 through to Step 3 (calendar)
async function navigateToCalendar(page) {
  log('Navigating to appointment page...');
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  let bodyText = await page.textContent('body');

  // Check if login is required
  if (bodyText.includes('Sign in') || bodyText.includes('Sign Up')) {
    log('Login required — entering credentials...');

    // Use exact selectors from the login form
    await page.fill('input#template-passport-login', CRED_EMAIL);
    await page.fill('input#template-passport-password', CRED_PASSWORD);
    await page.waitForTimeout(500);

    // Click the Sign in submit button
    await page.click('input[name="b_submit"][type="submit"]');
    log('Credentials submitted, waiting for login...');

    // Wait for navigation after login
    await page.waitForTimeout(8000);

    // Verify login succeeded
    bodyText = await page.textContent('body');
    if (bodyText.includes('Sign in to Continue')) {
      log('ERROR: Login failed. Check credentials.');
      await page.screenshot({ path: path.resolve(__dirname, 'logs/login-failed.png') });
      return false;
    }
    log('Login successful!');

    // After login, navigate to the appointment page again
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    bodyText = await page.textContent('body');
  }

  // Already on calendar
  if (bodyText.includes('Select date and time')) {
    log('Already on calendar page.');
    return true;
  }

  // Step 1: Select service — click "Book" next to "Private Session (1:1)"
  if (bodyText.includes('Select service')) {
    log('Step 1: Clicking Book on Private Session (1:1)...');
    const allBookBtns = page.locator('div.js-service-element-add');
    const count = await allBookBtns.count();
    if (count >= 2) {
      await allBookBtns.nth(1).scrollIntoViewIfNeeded();
      await allBookBtns.nth(1).click();
    } else if (count === 1) {
      await allBookBtns.first().click();
    }
    await page.waitForTimeout(3000);

    // Click "Select staff" button
    log('  Clicking "Select staff" button...');
    const staffBtn = page.locator('span.js-appointment-book-next-text:visible').locator('..');
    await staffBtn.scrollIntoViewIfNeeded();
    await staffBtn.click({ timeout: 10000 });
    await page.waitForTimeout(5000);
  }

  bodyText = await page.textContent('body');

  // Step 2: Select Jiyu Kim
  const jiyuKim = page.locator('div.js-staff-element').filter({ hasText: 'Jiyu Kim' }).first();
  if (await jiyuKim.isVisible({ timeout: 5000 }).catch(() => false)) {
    log('Step 2: Selecting Jiyu Kim...');
    await jiyuKim.scrollIntoViewIfNeeded();
    await jiyuKim.click();
    await page.waitForTimeout(2000);

    const nextBtn = page.locator('span.js-appointment-book-next-text:visible').locator('..');
    if (await nextBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      log('  Clicking Next...');
      await nextBtn.scrollIntoViewIfNeeded();
      await nextBtn.click();
      await page.waitForTimeout(5000);
    }
  }

  bodyText = await page.textContent('body');
  if (bodyText.includes('Select date and time')) {
    log('Reached calendar page!');
    return true;
  }

  log('WARNING: Did not reach calendar page.');
  await page.screenshot({ path: path.resolve(__dirname, 'logs/debug-screenshot.png') });
  return false;
}

// Scrape available slots directly from the calendar DOM
async function scrapeCalendar(page) {
  return await page.evaluate(() => {
    const results = { monthYear: '', availableDates: [], waitlistDates: [] };

    // Get month/year
    const subtitle = document.querySelector('.css-schedule-calendar-header .css-subtitle');
    if (subtitle) results.monthYear = subtitle.textContent.trim();

    // Get all calendar date cells
    const cells = document.querySelectorAll('div.js-wl-appointment-book-schedule-calendar-item');
    for (const cell of cells) {
      const classes = cell.className;
      const date = cell.getAttribute('data-date') || '';
      const dayNum = cell.querySelector('span')?.textContent?.trim() || '';

      if (classes.includes('js-enable') && !classes.includes('js-waitlist-only')) {
        results.availableDates.push({ date, day: dayNum });
      } else if (classes.includes('js-enable') && classes.includes('js-waitlist-only')) {
        results.waitlistDates.push({ date, day: dayNum });
      }
    }

    return results;
  });
}

// Click a date and scrape its available time slots
async function scrapeTimeSlotsForDate(page, dateValue) {
  // Click the date cell
  const cell = page.locator(`div.js-wl-appointment-book-schedule-calendar-item[data-date="${dateValue}"]`);
  await cell.click({ timeout: 5000 });
  await page.waitForTimeout(2000);

  // Scrape time slots
  return await page.evaluate(() => {
    const slots = [];
    const items = document.querySelectorAll('div.js-appointment-book-schedule-day-time-item');
    for (const item of items) {
      const isWaitlist = item.classList.contains('js-waitlist');
      const date = item.getAttribute('data-date') || '';
      const timeText = item.querySelector('.css-heading')?.textContent?.trim() || '';
      if (timeText && !isWaitlist) {
        slots.push({ date, time: timeText });
      }
    }
    return slots;
  });
}

async function scrapeAndCollectSlots(page) {
  const calendar = await scrapeCalendar(page);
  log(`Month: ${calendar.monthYear}`);
  log(`  Available dates: ${calendar.availableDates.map(d => d.day).join(', ') || 'none'}`);
  log(`  Waitlist-only dates: ${calendar.waitlistDates.map(d => d.day).join(', ') || 'none'}`);

  const slots = [];
  for (const dateInfo of calendar.availableDates) {
    try {
      const timeSlots = await scrapeTimeSlotsForDate(page, dateInfo.date);
      for (const slot of timeSlots) {
        const label = `${calendar.monthYear} ${dateInfo.day} @ ${slot.time}`;
        slots.push(label);
        log(`  AVAILABLE: ${label}`);
      }
      if (timeSlots.length === 0) {
        log(`  ${calendar.monthYear} ${dateInfo.day}: date available but no open time slots`);
      }
    } catch (err) {
      log(`  Error checking ${dateInfo.day}: ${err.message}`);
    }
  }
  return slots;
}

const MONTHS_TO_SCAN = parseInt(process.env.MONTHS_TO_SCAN || '2');

async function checkAvailability(page) {
  log('--- Checking availability ---');

  const reached = await navigateToCalendar(page);
  if (!reached) throw new Error('Failed to reach calendar page');

  const allSlots = [];

  // Scan current month + next month(s)
  for (let m = 0; m < MONTHS_TO_SCAN; m++) {
    if (m > 0) {
      // Click "View next month" (may be a div or span with this class)
      const nextArrow = page.locator('.js-wl-appointment-book-schedule-calendar-next:visible');
      if (await nextArrow.first().isVisible({ timeout: 3000 }).catch(() => false)) {
        await nextArrow.first().click();
        await page.waitForTimeout(3000);
      } else {
        log('No next month arrow found, stopping.');
        break;
      }
    }

    const slots = await scrapeAndCollectSlots(page);
    allSlots.push(...slots);
  }

  await page.screenshot({ path: path.resolve(__dirname, 'logs/last-check.png') });

  if (allSlots.length > 0) {
    log('*** AVAILABILITY FOUND ***');
    playSound();
  } else {
    log('No available (non-waitlist) slots.');
  }

  return allSlots;
}

async function checkGroupClasses(page) {
  log('--- Checking ALL group classes for Jiyu Kim ---');

  await page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Click Group Class tab
  const groupTab = page.locator('text=Group Class').first();
  if (!await groupTab.isVisible({ timeout: 5000 }).catch(() => false)) {
    log('WARNING: Group Class tab not found');
    return [];
  }
  await groupTab.click();
  await page.waitForTimeout(5000);

  const allClasses = [];

  for (let week = 0; week < WEEKS_TO_SCAN; week++) {
    if (week > 0) {
      const dateBtn = page.locator('button[title*="2026"]').first();
      const nextArrow = dateBtn.locator('xpath=following-sibling::button[1]');
      if (!await nextArrow.isVisible({ timeout: 3000 }).catch(() => false)) break;
      await nextArrow.click();
      await page.waitForTimeout(3000);
    }

    const weekData = await page.evaluate(() => {
      const text = document.body.innerText;
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      const classes = [];
      let currentDay = '';

      for (let i = 0; i < lines.length; i++) {
        const dayMatch = lines[i].match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(\w+ \d+,\s*\d{4})/);
        if (dayMatch) {
          currentDay = lines[i];
          continue;
        }
        if (lines[i].includes('Jiyu Kim') && currentDay) {
          let time = '', className = '', availability = '', bookingSoon = false;
          for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
            if (lines[j].match(/^\d{1,2}:\d{2}\s*(am|pm)\s*PT$/i)) {
              time = lines[j];
              break;
            }
          }
          for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
            if (lines[j].match(/(Pilates|Barre|Happy Hour|Reformer|Core|Beginner|Sculpt)/i)) {
              className = lines[j];
              break;
            }
          }
          for (let j = i + 1; j <= Math.min(lines.length - 1, i + 4); j++) {
            if (lines[j].match(/(spot|waitlist|Booking starts)/i)) {
              availability = lines[j];
              if (lines[j].includes('Booking starts')) bookingSoon = true;
              break;
            }
          }
          classes.push({ day: currentDay, time, className, availability, bookingSoon });
        }
      }
      return classes;
    });

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });

    for (const c of weekData) {
      const dateMatch = c.day.match(/(\w+)\s+(\d+),\s*(\d{4})/);
      if (dateMatch) {
        const classDate = new Date(`${dateMatch[1]} ${dateMatch[2]}, ${dateMatch[3]}`);
        const classDayStr = classDate.toLocaleDateString('en-CA');
        if (classDayStr < today) continue;
      }

      const spotsMatch = c.availability.match(/(\d+)\s*spots?\s*left/i);
      const spotsLeft = spotsMatch ? parseInt(spotsMatch[1]) : 0;
      const isBookable = spotsLeft > 0 && !c.bookingSoon;
      const label = `${c.className} - ${c.day} ${c.time} (${c.availability})`;
      const status = c.bookingSoon ? 'not open' : (spotsLeft > 0 ? 'AVAILABLE' : 'full');
      log(`  ${status}: ${label}`);
      if (isBookable) {
        allClasses.push(label);
      }
    }
  }

  if (allClasses.length > 0) {
    log('*** GROUP CLASS AVAILABILITY FOUND ***');
  } else {
    log('No available group class spots with Jiyu Kim.');
  }

  return allClasses;
}

const MAX_RETRIES = 2;

async function runCheck(page) {
  let privateSlots = [];
  let groupClasses = [];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      privateSlots = await checkAvailability(page);
      break;
    } catch (err) {
      log(`Error during appointment check (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
      await page.screenshot({ path: path.resolve(__dirname, 'logs/error-screenshot.png') }).catch(() => {});
      if (attempt < MAX_RETRIES) {
        log('Retrying appointment check...');
        await page.waitForTimeout(15000);
      }
    }
  }
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      groupClasses = await checkGroupClasses(page);
      break;
    } catch (err) {
      log(`Error during group class check (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
      await page.screenshot({ path: path.resolve(__dirname, 'logs/error-group-screenshot.png') }).catch(() => {});
      if (attempt < MAX_RETRIES) {
        log('Retrying group class check...');
        await page.waitForTimeout(15000);
      }
    }
  }

  if (privateSlots.length > 0 || groupClasses.length > 0) {
    const parts = ['🎉 Jiyu Kim 有空位!'];
    if (privateSlots.length > 0) {
      parts.push('\n📌 Private Session:');
      parts.push(privateSlots.join('\n'));
    }
    if (groupClasses.length > 0) {
      parts.push('\n📌 Group Class:');
      parts.push(groupClasses.join('\n'));
    }
    await sendNotification(parts.join('\n'));
  }
}

async function waitForNetwork(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return false;
}

function cleanStaleLockFiles() {
  const lockFile = path.join(SESSION_DIR, 'SingletonLock');
  const socketFile = path.join(SESSION_DIR, 'SingletonSocket');
  const cookieLock = path.join(SESSION_DIR, 'SingletonCookie');
  for (const f of [lockFile, socketFile, cookieLock]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

async function main() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, '');

  log('=== WellnessLiving Slot Monitor ===');
  log(`Environment: ${IS_CLOUD ? 'cloud' : 'local'}`);

  if (!IS_CLOUD) {
    if (!await waitForNetwork()) {
      log('No network after 60s, aborting run.');
      return;
    }
    cleanStaleLockFiles();
  }

  const launchOptions = {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
    viewport: { width: 1280, height: 900 },
  };

  // Use system Chrome locally, Playwright's bundled Chromium in cloud
  if (!IS_CLOUD) {
    launchOptions.channel = 'chrome';
  }

  const browser = await chromium.launchPersistentContext(SESSION_DIR, launchOptions);
  const page = browser.pages()[0] || await browser.newPage();

  await checkNewSubscribers();
  await runCheck(page);

  await browser.close();
  log('=== Done ===');
}

main();
