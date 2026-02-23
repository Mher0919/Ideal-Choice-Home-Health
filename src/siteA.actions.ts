// siteA.actions.ts
import { Locator, Page } from 'playwright';
import fs from 'fs';
import path from 'path';

export async function openPatientManager(pageA: Page) {
  console.log('Opening Patient Manager in Site A');

  // Dismiss any leftover overlay before interacting with the menu
  try {
    const overlay = pageA.locator('div.ui-widget-overlay');
    if (await overlay.count() > 0) {
      await pageA.keyboard.press('Escape');
      await pageA.waitForTimeout(400);
      if (await overlay.count() > 0) {
        await pageA.evaluate(() => {
          document.querySelectorAll('.ui-widget-overlay').forEach(el => el.remove());
        });
        await pageA.waitForTimeout(200);
      }
    }
  } catch { /* non-fatal */ }

  const menuButton = pageA.locator('a.menuButton:has-text("Go to")');
  await menuButton.click();
  
  // Wait until the menu item exists
  const patientManagerLink = pageA.locator(
    'a.menuitem:has-text("Patient Manager")'
  );

  await patientManagerLink.waitFor({ state: 'visible', timeout: 10000 });
  await patientManagerLink.click();

  // Wait for Patient Manager page to load
  await pageA.waitForLoadState('networkidle');

  console.log('Patient Manager opened');
}

function getLastNameInitial(fullName: string): string {
  // "Jackson, Mercedes" → "J"
  return fullName.split(',')[0].trim().charAt(0).toUpperCase();
}


export async function clickLetterInPatientManager(
  pageA: Page,
  patientName: string
) {
  const letter = getLastNameInitial(patientName);
  console.log(`Clicking letter ${letter} in Site A`);

  const letterLink = pageA.locator(
    `#characterTable a#${letter}`
  );

  await letterLink.waitFor({ state: 'visible', timeout: 10000 });
  await letterLink.click();

  // Wait for patient list to refresh
  await pageA.waitForSelector('#sortTable1 tr', { timeout: 15000 });
}

export async function clickPatientByName(
  pageA: Page,
  patientName: string
) {
  console.log(`Searching for patient "${patientName}" in Site A`);

  const patientLink = pageA.locator(
    `#sortTable1 a:has-text("${patientName}")`
  );

  await patientLink.first().waitFor({
    state: 'visible',
    timeout: 15000
  });

  await patientLink.first().click();

  console.log(`Patient "${patientName}" opened in Site A`);
}


export async function openAllTherapyTab(pageA: Page) {
  const therapyTab = pageA.locator('a#LinkTherapy');
  await therapyTab.waitFor({ state: 'visible', timeout: 10000 });
  await therapyTab.click();
  await pageA.waitForLoadState('networkidle');
}

/* -------------------- VISIT SCANNING -------------------- */

export interface Visit {
  taskName: string;
  therapist: string;
  visitDate: string;
  targetDate: string;
  siteBVisitName: string;
  rowIndex: number;
  needsAction: boolean;
  actualVisitType: string;
}



const SOC_NAMES = [
  'SOC',
  'SOC OASIS',
  'START OF CARE',
  'OASIS-E1 START'
];

const DISCHARGE_NAMES = [
  'DISCHARGE',
  'DC OASIS',
  'OASIS-E1 DISCHARGE',
  'OASIS-E1 DC',
];

export function isSOC(visitType: string) {
  return SOC_NAMES.some(k =>
    visitType.toUpperCase().includes(k)
  );
}

export function isDischarge(visitType: string) {
  return DISCHARGE_NAMES.some(k =>
    visitType.toUpperCase().includes(k)
  );
}

/** Skip "Del ..." cancelled/deleted visits */
export function isDeleted(visitType: string) {
  return visitType.trim().toUpperCase().startsWith('DEL ');
}


/**
 * Collects ALL incomplete/actionable visits in a single DOM pass.
 *
 * KEY FIXES vs. original:
 *  1. No `data-processed` mutation during iteration — we read all rows
 *     upfront so index drift is impossible.
 *  2. `needsAction` is computed correctly:
 *       - true  → visit date is missing  OR  no attachment icon (paperclip)
 *       - false → visit date is present  AND attachment icon exists (already done)
 *     Visits with needsAction=false are skipped entirely.
 *  3. SOC visits are skipped here too (same as before), but now guaranteed
 *     to be skipped even when they appear in the middle of the table.
 */
export async function getAllIncompleteVisits(page: Page): Promise<Visit[]> {
  const visits: Visit[] = [];

  // Select every data row that has the visit-cell class.
  // We do NOT filter with :not([data-processed]) — we do one clean pass.
  const rows = page.locator('table#scheduled-task tbody tr')
    .filter({ has: page.locator('td.CellBottom.padding-left') });

  const rowCount = await rows.count();
  console.log(`  ↳ Total therapy rows found: ${rowCount}`);

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);

    // ── Task name ──────────────────────────────────────────────────────────
    const taskNameRaw = (
      await row.locator('td.CellBottom.padding-left div.left').allInnerTexts()
    )
      .join(' ')
      .replace(/\u00A0/g, ' ')
      .trim();

    const taskName = taskNameRaw.replace(/\s+/g, ' ');

    // Skip blank rows, SOC rows, Discharge rows, and deleted (Del ...) rows
    if (!taskName || isSOC(taskName) || isDischarge(taskName) || isDeleted(taskName)) {
      console.log(`  Row ${i}: skipped (blank, SOC, Discharge, or Deleted) — "${taskName}"`);
      continue;
    }

    // ── Attachment icon (paperclip) ────────────────────────────────────────
    const hasIcon = await row.locator('img[alt="Click to view Attachments"]').count();

    // ── Visit date ─────────────────────────────────────────────────────────
    // Try the plain div first; fall back to its child input for date-pickers.
    let visitDate = (
      await row.locator('td.CellBottom div[id^="VisitDate"]').first().innerText()
    ).trim();

    if (!visitDate) {
      const inputCount = await row
        .locator('td.CellBottom div[id^="VisitDate"] input')
        .count();
      if (inputCount > 0) {
        visitDate = await row
          .locator('td.CellBottom div[id^="VisitDate"] input')
          .first()
          .inputValue();
      }
    }

    // ── Target date ────────────────────────────────────────────────────────
    const targetDate = (
      await row.locator('td.CellBottom div[id^="TargetDate"]').first().innerText()
    ).trim();

    // ── needsAction logic ──────────────────────────────────────────────────
    // A visit needs action when:
    //   • visit date is missing (only target date assigned), OR
    //   • visit date is present but no attachment has been uploaded yet
    //
    // A visit is COMPLETE (skip it) when visit date AND attachment both exist.
    const isComplete = Boolean(visitDate) && hasIcon > 0;

    if (isComplete) {
      console.log(`  Row ${i}: already complete — "${taskName}" (${visitDate})`);
      continue;
    }

    // ── Therapist ──────────────────────────────────────────────────────────
    const therapistCell = row.locator('td[patienttaskkey]').first();
    const therapist = (
      await therapistCell.evaluate((el) => el.textContent?.trim() || '')
    );

    // ── Map task name → Site B visit name ─────────────────────────────────
    let siteBVisitName = '';
    let actualVisitType = 'Standard';

    if (/SOC OASIS|OASIS-E1 Start of Care/i.test(taskName)) {
      siteBVisitName = 'SOC OASIS';
      actualVisitType = 'SOC';
    } else if (/INITIAL EVAL/i.test(taskName)) {
      siteBVisitName = 'Evaluation';
      actualVisitType = 'Evaluation';
    } else if (/STANDARD/i.test(taskName)) {
      siteBVisitName = 'Visit';
      actualVisitType = 'Standard';
    } else if (/REASSESSMENT/i.test(taskName)) {
      siteBVisitName = 'Re-Evaluation';
      actualVisitType = 'Reassessment';
    } else if (/RECERT/i.test(taskName)) {
      siteBVisitName = 'Recertification';
      actualVisitType = 'Recertification';
    } else if (/DISCHARGE/i.test(taskName)) {
      siteBVisitName = 'Discharge';
      actualVisitType = 'Discharge';
    } else if (/OTA standard/i.test(taskName)) {
      siteBVisitName = 'COTA visit';
      actualVisitType = 'COTA';
    } else {
      siteBVisitName = taskName;
      actualVisitType = 'Other';
    }

    console.log(
      `  Row ${i}: ACTIONABLE — "${taskName}" | visitDate="${visitDate}" | targetDate="${targetDate}" | needsAction=true`
    );

    visits.push({
      taskName,
      therapist,
      visitDate,        // may be empty string — that is intentional
      targetDate,
      siteBVisitName,
      rowIndex: i,
      needsAction: true,
      actualVisitType,
    });
  }

  console.log(`  ↳ Actionable visits collected: ${visits.length}`);
  return visits;
}

// ── findNextIncompleteVisit is kept for backwards-compat but now delegates ──
// to getAllIncompleteVisits so the logic stays in one place.
export async function findNextIncompleteVisit(page: Page): Promise<Visit | null> {
  const all = await getAllIncompleteVisits(page);
  return all.length > 0 ? all[0] : null;
}

function convertTo24h(time: string): string {
  const match = time.match(/(\d+)(?::(\d+))?\s*(AM|PM)/i);
  if (!match) return '00:00';
  let [_, hourStr, minStr, ampm] = match;
  let hour = parseInt(hourStr);
  const min = minStr ? parseInt(minStr) : 0;
  if (ampm.toUpperCase() === 'PM' && hour < 12) hour += 12;
  if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
  return `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
}

const normalize = (s: string) =>
  s.replace(/\s+/g, ' ')
   .replace(/\u00A0/g, ' ')
   .replace(/[^\x00-\x7F]/g, '')
   .trim()
   .toLowerCase();
   
function normalizeDate(dateStr: string): string {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return dateStr;

  let [month, day, year] = parts;

  month = String(parseInt(month));
  day = String(parseInt(day));

  return `${month}/${day}/${year}`;
}

export async function clickDetailsInSiteA(
  pageA: Page,
  visitName: string,
  visitDate: string,
  therapist?: string
) {
  await openAllTherapyTab(pageA);

  console.log(`🔎 Site A: looking for "${visitName}" on ${visitDate}`);

  const expectedName = normalize(visitName);
  const expectedDate = normalizeDate(visitDate);

  const scheduleTable = pageA.locator('table#scheduled-task');
  await scheduleTable.waitFor({ state: 'visible', timeout: 15000 });

  const rows = scheduleTable.locator('tbody tr');
  const rowCount = await rows.count();

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);

    const nameCell = row.locator('td.CellBottom div.left').first();
    if (!(await nameCell.count())) continue;

    const rowName = normalize(await nameCell.innerText());
    const possibleNames = [
      expectedName,
      expectedName.replace('cota visit', 'ota standard'),
      expectedName.replace('pta visit', 'pta standard'),
      expectedName.replace('visit', 'standard'),
    ];

    if (!possibleNames.some(name => rowName.includes(name))) continue;

    // ── Date matching: also accept target date when visit date is blank ──
    const dateDiv = row.locator('div[id^="VisitDate"]:not([id*="Input"])').first();
    const targetDiv = row.locator('div[id^="TargetDate"]').first();

    let rowVisitDate = '';
    if (await dateDiv.count()) {
      rowVisitDate = normalizeDate((await dateDiv.innerText()).trim());
    }

    let rowTargetDate = '';
    if (await targetDiv.count()) {
      rowTargetDate = normalizeDate((await targetDiv.innerText()).trim());
    }

    // Match on visit date OR target date (handles target-date-only rows)
    const dateMatches =
      rowVisitDate === expectedDate ||
      (!rowVisitDate && rowTargetDate === expectedDate) ||
      rowTargetDate === expectedDate;

    if (!dateMatches) continue;

    if (therapist) {
      const assignedCell = row.locator('td[id^="Assigned"]').first();
      if (await assignedCell.count()) {
        const rowTherapist = normalize(await assignedCell.innerText());
        if (!rowTherapist.includes(normalize(therapist))) continue;
      }
    }

    const detailsLink = row.locator('a[id^="Details"]').first();
    await detailsLink.scrollIntoViewIfNeeded();
    await detailsLink.click();
    await pageA.waitForLoadState('networkidle');

    console.log('✅ Site A Details clicked');
    return;
  }

  // ---- Debug dump on failure ----
  console.log("❌ FAILED MATCH");
  console.log("Expected:", { expectedName, expectedDate, therapist });

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);

    const nameCell = row.locator('td.CellBottom div.left').first();
    const rowNameRaw = (await nameCell.count()) ? await nameCell.innerText() : "";
    const rowName = normalize(rowNameRaw);

    const dateDiv = row.locator('td.CellBottom div[id^="VisitDate"]').first();
    const rowDateRaw = (await dateDiv.count()) ? await dateDiv.innerText() : "";
    const rowDate = normalizeDate(rowDateRaw);

    const targetDiv = row.locator('td.CellBottom div[id^="TargetDate"]').first();
    const targetDateRaw = (await targetDiv.count()) ? await targetDiv.innerText() : "";

    console.log(`Row ${i} RAW:`, { name: rowNameRaw, visitDate: rowDateRaw, targetDate: targetDateRaw });
    console.log(`Row ${i} NORMALIZED:`, { name: rowName, visitDate: rowDate });
  }

  throw new Error(`Site A visit not found: ${visitName} ${visitDate}`);
}

export async function checkVisitDateAndTimesFilled(pageA: Page) {
  const dateFilled =
    (await pageA.locator('#VisitdateMonth').inputValue()) &&
    (await pageA.locator('#VisitdateDay').inputValue()) &&
    (await pageA.locator('#VisitdateYear').inputValue());

  const timeInFilled =
    (await pageA.locator('#timeinHour').inputValue()) &&
    (await pageA.locator('#timeinMinutes').inputValue());

  const timeOutFilled =
    (await pageA.locator('#TimeOutHour').inputValue()) &&
    (await pageA.locator('#TimeOutMinutes').inputValue());

  return {
    dateFilled: Boolean(dateFilled),
    timeInFilled: Boolean(timeInFilled),
    timeOutFilled: Boolean(timeOutFilled),
  };
}

export async function openVisitFromViewMenu(
  pageA: Page,
  visitName: string
) {
  const normalize = (s: string) =>
    s.replace(/\s+/g, ' ').trim().toLowerCase();

  await pageA.locator('a.menuButton', { hasText: 'View' }).click();

  const menuItems = pageA.locator('a.menuitem');
  await menuItems.first().waitFor({ timeout: 5000 });

  const count = await menuItems.count();
  for (let i = 0; i < count; i++) {
    const item = menuItems.nth(i);
    const text = normalize(await item.innerText());

    if (text.includes(normalize(visitName))) {
      await item.click();
      await pageA.waitForLoadState('networkidle');
      return;
    }
  }

  throw new Error(`View menu visit not found: ${visitName}`);
}

/**
 * Fill date, time in, time out for a visit in Site A
 */
export async function fillVisitDateAndTimesInSiteA(
  pageA: Page,
  visitDate: string,
  timeIn: string,
  timeOut: string
) {
  await pageA.fill('#frm_timein', convertTo24h(timeIn));
  await pageA.fill('#frm_timeout', convertTo24h(timeOut));
  await pageA.fill('#frm_visitdate', visitDate);
}

/**
 * Click Approve button in Site A
 */
export async function approveVisit(pageA: Page) {
  await pageA.locator('#btnApprove input').click();
  await pageA.waitForLoadState('networkidle');
  console.log('Approved visit in Site A');
}

/**
 * Upload PDF attachment for a visit in Site A
 */
export async function uploadAttachment(
  pageA: Page,
  filePath: string
) {
  const fileInput = pageA.locator('#attachment');
  await fileInput.setInputFiles(filePath);

  await pageA.locator('#uploadAttachmentattachment').click();
  await pageA.waitForTimeout(1000);

  console.log(`Uploaded file: ${filePath}`);
}

/**
 * Click Update Task button after attachments uploaded
 */
export async function updateTask(pageA: Page) {
  await pageA.locator('#taskdetailsubmit').click();
  await pageA.waitForLoadState('networkidle');
  console.log('Updated Task in Site A');
}

/**
 * Dismiss any jQuery UI modal overlay that may be blocking clicks.
 * The overlay appears as <div class="ui-widget-overlay"> and is left behind
 * after file chooser dialogs or modal popups close.
 */
export async function dismissOverlay(page: Page): Promise<void> {
  try {
    const overlay = page.locator('div.ui-widget-overlay');
    if (await overlay.count() > 0) {
      console.log('  ⚠ Overlay detected — dismissing...');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      if (await overlay.count() > 0) {
        await page.evaluate(() => {
          document.querySelectorAll('.ui-widget-overlay').forEach(el => el.remove());
        });
        await page.waitForTimeout(200);
      }
    }
  } catch { /* non-fatal */ }
}

/**
 * Add a missing visit in Site A using the episode manager form.
 *
 * Form structure (from HTML):
 *   - #PatientTask1     → <select> with visit type options (e.g. "PTA Visit")
 *   - #AMUserkey1       → <select> with therapist options (e.g. "Diaz, Jessica")
 *   - #TaskDate1        → read-only text input, populated by clicking calendar cell
 *   - Calendar cells    → onclick="FillDate(day, month, year)"
 *   - #SubmitUpdateTasks → Insert/Update button
 */
export async function addMissingVisitInSiteA(
  pageA: Page,
  visitName: string,      // e.g. "PTA Visit" — must match an <option> in #PatientTask1
  visitDate: string,      // MM/DD/YYYY or M/D/YYYY
  therapist: string,      // e.g. "JESSICA DIAZ (PTA)" — partial last-name match used
  actualVisitType: string // unused now but kept for API compatibility
): Promise<boolean> {

  console.log(`➕ Adding missing visit in Site A: ${visitName} on ${visitDate}`);

  try {
    // ── 1. Parse the date ────────────────────────────────────────────────────
    const dateParts = visitDate.split('/');
    if (dateParts.length !== 3) {
      console.log(`⚠ Invalid date format: ${visitDate} — skipping`);
      return false;
    }
    const [month, day, year] = dateParts.map(p => parseInt(p.trim()));

    // ── 2. Wait for the first task row to be visible ─────────────────────────
    await pageA.waitForSelector('#PatientTask1', { state: 'visible', timeout: 15000 });

    // ── 3. Select visit type in #PatientTask1 ────────────────────────────────
    const taskSelect = pageA.locator('#PatientTask1');
    const taskOption = taskSelect.locator(`option:text-is("${visitName.trim()}")`);

    if (!(await taskOption.count())) {
      const allOptions = await taskSelect.locator('option').allInnerTexts();
      const matchedLabel = allOptions.find(o =>
        o.trim().toLowerCase() === visitName.trim().toLowerCase()
      );
      if (!matchedLabel) {
        console.log(`⚠ Visit type "${visitName}" not found in #PatientTask1 — skipping`);
        console.log(`   Available options: ${allOptions.slice(0, 10).join(', ')}...`);
        return false;
      }
      await taskSelect.selectOption({ label: matchedLabel });
    } else {
      await taskSelect.selectOption({ label: visitName.trim() });
    }

    console.log(`  ✓ Selected visit type: ${visitName}`);

    // ── 4. Select therapist in #AMUserkey1 ───────────────────────────────────
    // Site B format: "PATRIC BARNES (PTA)"  → firstName="patric"  lastName="barnes"
    // Site A format: "Barnes, Patric"        → match on lastName first, then firstName
    const therapistSelect = pageA.locator('#AMUserkey1');
    const therapistOptions = await therapistSelect.locator('option').all();

    // Parse Site B therapist string: strip credential in parens, split into words
    const therapistNorm = therapist.toLowerCase().replace(/\(.*\)/, '').trim();
    const therapistWords = therapistNorm.split(/\s+/).filter(Boolean);
    // Last word is last name, everything before is first name(s)
    const lastName  = therapistWords[therapistWords.length - 1];
    const firstName = therapistWords.slice(0, therapistWords.length - 1).join(' ');

    // Score each option: 2pts for last name match + 1pt for first name match
    // Highest score wins; must have at least a last name match (score >= 2)
    let bestValue: string | null = null;
    let bestLabel = '';
    let bestScore = 0;

    for (const opt of therapistOptions) {
      const text = (await opt.innerText()).trim().toLowerCase(); // e.g. "barnes, patric"
      const val  = await opt.getAttribute('value');
      if (!val || !text) continue;

      let score = 0;
      // Last name match: Site A option starts with "lastname,"
      if (text.startsWith(lastName + ',') || text.split(',')[0].trim() === lastName) {
        score += 2;
      }
      // First name match: text after the comma contains the first name
      if (firstName && text.includes(firstName)) {
        score += 1;
      }

      if (score > bestScore) {
        bestScore = score;
        bestValue = val;
        bestLabel = (await opt.innerText()).trim();
      }
    }

    if (!bestValue || bestScore < 2) {
      console.log(`⏭ Therapist "${therapist}" (last: "${lastName}", first: "${firstName}") not found in Site A — skipping`);
      return false;
    }

    await therapistSelect.selectOption({ value: bestValue });
    console.log(`  ✓ Selected therapist: ${bestLabel}`);

    // ── 5. Click the calendar cell to set the date ───────────────────────────
    const calendarCell = pageA.locator(
      `td[onclick="FillDate(${day}, ${month}, ${year})"]`
    );

    if (!(await calendarCell.count())) {
      console.log(`  ℹ Calendar cell not visible — calling FillDate(${day}, ${month}, ${year}) via JS`);
      await pageA.evaluate(
        ([d, m, y]) => {
          if (typeof (window as any).FillDate === 'function') {
            (window as any).FillDate(d, m, y);
          }
        },
        [day, month, year]
      );
    } else {
      await calendarCell.first().click();
    }

    await pageA.waitForTimeout(500);
    const filledDate = await pageA.locator('#TaskDate1').inputValue();
    console.log(`  ✓ TaskDate1 filled with: "${filledDate}"`);

    if (!filledDate) {
      console.log(`  ⚠ Date field empty after calendar click — skipping`);
      return false;
    }

    // ── 6. Click Insert/Update Task(s) ───────────────────────────────────────
    const submitBtn = pageA.locator('#SubmitUpdateTasks');
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
    await submitBtn.click();
    await pageA.waitForLoadState('networkidle');

    console.log(`✅ Added missing visit: ${visitName} on ${visitDate} for ${therapist}`);
    return true;

  } catch (error) {
    console.log(`❌ Failed to add visit ${visitName} on ${visitDate}`);
    console.log(error);
    return false;
  }
}
