const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Support env vars (for Railway) or config.json (for local)
const configPath = path.resolve(__dirname, 'config.json');
const config = fs.existsSync(configPath) ? require(configPath) : {};

const IS_CLOUD = process.env.RAILWAY_ENVIRONMENT || process.env.IS_CLOUD || false;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MS || config.checkIntervalMs || 120000);
const CRED_EMAIL = process.env.WL_EMAIL || config.credentials?.email;
const CRED_PASSWORD = process.env.WL_PASSWORD || config.credentials?.password;
const NOTIFY_WEBHOOK = process.env.NOTIFY_WEBHOOK || config.notifyWebhook || '';

const SESSION_DIR = path.resolve(__dirname, config.sessionDir || '.chrome-session');
const LOG_FILE = path.resolve(__dirname, config.logFile || 'logs/availability.log');
const START_URL = 'https://www.wellnessliving.com/rs/appointment-new/rejenerate_pilates';

let previousSlots = new Set();
let isFirstRun = true;

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

async function sendNotification(message) {
  log(`NOTIFICATION: ${message}`);
  if (!NOTIFY_WEBHOOK) return;
  try {
    const res = await fetch(NOTIFY_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message, content: message }),
    });
    log(`Webhook response: ${res.status}`);
  } catch (err) {
    log(`Webhook error: ${err.message}`);
  }
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
    await page.fill('input#template-passport-login', config.credentials.email);
    await page.fill('input#template-passport-password', config.credentials.password);
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
  const jiyuKim = page.locator('div.js-staff-element[data-staff="617910"]');
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

async function checkAvailability(page) {
  log('--- Checking availability ---');

  const reached = await navigateToCalendar(page);
  if (!reached) return;

  // Scrape calendar state
  const calendar = await scrapeCalendar(page);
  log(`Month: ${calendar.monthYear}`);
  log(`Available dates: ${calendar.availableDates.map(d => d.day).join(', ') || 'none'}`);
  log(`Waitlist-only dates: ${calendar.waitlistDates.map(d => d.day).join(', ') || 'none'}`);

  // Click each available date and get time slots
  const allSlots = [];

  for (const dateInfo of calendar.availableDates) {
    try {
      const timeSlots = await scrapeTimeSlotsForDate(page, dateInfo.date);
      for (const slot of timeSlots) {
        const label = `${calendar.monthYear} ${dateInfo.day} @ ${slot.time}`;
        allSlots.push(label);
        log(`  AVAILABLE: ${label}`);
      }
      if (timeSlots.length === 0) {
        log(`  ${calendar.monthYear} ${dateInfo.day}: date available but no open time slots`);
      }
    } catch (err) {
      log(`  Error checking ${dateInfo.day}: ${err.message}`);
    }
  }

  await page.screenshot({ path: path.resolve(__dirname, 'logs/last-check.png') });

  // Compare against previous state
  const currentSlots = new Set(allSlots);
  const newSlots = [...currentSlots].filter(s => !previousSlots.has(s));

  if (newSlots.length > 0 && !isFirstRun) {
    log('*** NEW AVAILABILITY DETECTED! ***');
    for (const slot of newSlots) {
      log(`  NEW: ${slot}`);
    }
    for (let i = 0; i < 3; i++) {
      playSound();
    }
    await sendNotification(`New slots available with Jiyu Kim!\n${newSlots.join('\n')}`);
  } else if (allSlots.length === 0) {
    log('No available (non-waitlist) slots.');
  }

  previousSlots = currentSlots;
  isFirstRun = false;
}

async function main() {
  log('=== WellnessLiving Slot Monitor Started ===');
  log(`Check interval: ${CHECK_INTERVAL / 1000}s`);
  log(`Environment: ${IS_CLOUD ? 'cloud' : 'local'}`);

  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

  // Clear log file on startup
  fs.writeFileSync(LOG_FILE, '');

  const launchOptions = {
    headless: IS_CLOUD ? true : false,
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

  // Run first check
  try {
    await checkAvailability(page);
  } catch (err) {
    log(`Error during check: ${err.message}`);
    await page.screenshot({ path: path.resolve(__dirname, 'logs/error-screenshot.png') }).catch(() => {});
  }

  // Schedule periodic checks
  const interval = setInterval(async () => {
    try {
      await checkAvailability(page);
    } catch (err) {
      log(`Error during check: ${err.message}`);
      await page.screenshot({ path: path.resolve(__dirname, 'logs/error-screenshot.png') }).catch(() => {});
    }
  }, CHECK_INTERVAL);

  process.on('SIGINT', async () => {
    log('Shutting down...');
    clearInterval(interval);
    await browser.close();
    process.exit(0);
  });
}

main();
