// siteA.actions.ts
import { Locator, Page } from 'playwright';
import fs from 'fs';
import path from 'path';

export async function openPatientManager(pageA: Page) {
  console.log('Opening Patient Manager in Site A');

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

  //await pageA.waitForLoadState('networkidle');

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
  rowIndex: number;       // helps click the right row later
  needsAction: boolean;    // <-- new
  actualVisitType: string; // e.g., "Standard", "Reassessment"
}



const SOC_NAMES = [
  'SOC',
  'SOC OASIS',
  'START OF CARE',
  'OASIS-E1 START'
];

export function isSOC(visitType: string) {
  return SOC_NAMES.some(k =>
    visitType.toUpperCase().includes(k)
  );
}


export async function findNextIncompleteVisit(page: Page): Promise<Visit | null> {
  const rows = page.locator('table#scheduled-task tbody tr:not([data-processed])')
    .filter({ has: page.locator('td.CellBottom.padding-left') });

  const rowCount = await rows.count();
  if (rowCount === 0) return null;

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);

    // Combine all text in div.left to avoid missing visits
    const taskNameRaw = (await row.locator('td.CellBottom.padding-left div.left').allInnerTexts())
                          .join(' ')
                          .replace(/\u00A0/g, ' ')
                          .trim();
    const taskName = taskNameRaw.replace(/\s+/g, ' '); // collapse multiple spaces/newlines

    // Skip truly empty names or SOCs
    if (!taskName || isSOC(taskName)) continue;

    // Skip completed visits (paperclip icon exists)
    const hasIcon = await row.locator('img[alt="Click to view Attachments"]').count();

    // Get therapist
    const therapistCell = row.locator('td[patienttaskkey]').first();
    const therapist = (await therapistCell.evaluate(el => el.textContent?.trim() || ''));

    // Get visit & target dates
    let visitDate = (await row.locator('td.CellBottom div[id^="VisitDate"]').first().innerText()).trim();
    if (!visitDate) {
        // Only try input fallback if the div is completely empty
        const inputCount = await row.locator('td.CellBottom div[id^="VisitDate"] input').count();
        if (inputCount > 0) {
          visitDate = await row.locator('td.CellBottom div[id^="VisitDate"] input').first().inputValue();
        }
    }
    const targetDate = (await row.locator('td.CellBottom div[id^="TargetDate"]').first().innerText()).trim();

    // Determine if visit needs action
    const needsAction = !visitDate || hasIcon === 0;

    // Map task name to Site B visit name
    let siteBVisitName = '';
    let actualVisitType = 'Standard'; // default
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

    return {
      taskName,
      therapist,
      visitDate,
      targetDate,
      siteBVisitName,
      rowIndex: i,
      needsAction,
      actualVisitType
    };
  }

  return null;
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


// ------------------- GET ALL INCOMPLETE VISITS -------------------

export async function getAllIncompleteVisits(page: Page): Promise<Visit[]> {
  const visits: Visit[] = [];
  let visit: Visit | null;

  while ((visit = await findNextIncompleteVisit(page)) !== null) {
    visits.push(visit);

    // Mark row as processed so it won't be picked again
    await page.locator('table#scheduled-task tbody tr:not([data-processed])')
      .nth(visit.rowIndex)
      .evaluate(el => el.setAttribute('data-processed', 'true'));
  }

  return visits;
}
const normalize = (s: string) =>
  s.replace(/\s+/g, ' ')
   .replace(/\u00A0/g, ' ')      // non-breaking spaces
   .replace(/[^\x00-\x7F]/g, '') // remove other special chars
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
  const expectedDate = normalizeDate(visitDate); // Site A uses MM/DD/YYYY

  // ---- Target the schedule table explicitly ----
  const scheduleTable = pageA.locator('table#scheduled-task');
  await scheduleTable.waitFor({ state: 'visible', timeout: 15000 });

  const rows = scheduleTable.locator('tbody tr');
  const rowCount = await rows.count();

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);

    // ---- Visit name ----
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

    // ---- Visit date ----
    const dateDiv = row.locator('div[id^="VisitDate"]:not([id*="Input"])').first();
    if (!(await dateDiv.count())) continue;

    const rowDate = normalizeDate((await dateDiv.innerText()).trim());
    if (rowDate !== expectedDate) continue;

    // ---- Therapist (optional) ----
    if (therapist) {
      const assignedCell = row.locator('td[id^="Assigned"]').first();
      if (await assignedCell.count()) {
        const rowTherapist = normalize(await assignedCell.innerText());
        if (!rowTherapist.includes(normalize(therapist))) continue;
      }
    }

    // ✅ FOUND → click Details
    const detailsLink = row.locator('a[id^="Details"]').first();
    await detailsLink.click();
    await pageA.waitForLoadState('networkidle');

    console.log('✅ Site A Details clicked');
    return;
  }

  // ---- Log all rows if nothing matched ----
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

    console.log(`Row ${i} RAW:`, { name: rowNameRaw, date: rowDateRaw });
    console.log(`Row ${i} NORMALIZED:`, { name: rowName, date: rowDate });
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

  // 1️⃣ Click View button
  await pageA.locator('a.menuButton', { hasText: 'View' }).click();

  // 2️⃣ Wait for menu items to appear
  const menuItems = pageA.locator('a.menuitem');
  await menuItems.first().waitFor({ timeout: 5000 });

  // 3️⃣ Click matching visit name
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

  // Click Upload Attachment
  await pageA.locator('#uploadAttachmentattachment').click();
  await pageA.waitForTimeout(1000); // wait for upload

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

export async function addMissingVisitInSiteA(
  pageA: Page,
  visitName: string,
  visitDate: string,
  therapist: string,
  actualVisitType: string // e.g., "Standard", "Evaluation", "Reassessment"
): Promise<boolean> {

  console.log(`➕ Adding missing visit in Site A: ${visitName} on ${visitDate}`);

  try {
    // 2️⃣ Wait for form
    await pageA.waitForSelector('#AddVisitForm', {
      state: 'visible',
      timeout: 10000
    });

    // 3️⃣ Fill task name
    const taskTypeInput = pageA.locator('#TaskType');
    await taskTypeInput.fill(visitName.trim());

    // 4️⃣ Select visit type (if exists)
    const visitTypeSelect = pageA.locator('#VisitType');
    const visitTypeOption = visitTypeSelect.locator('option', {
      hasText: actualVisitType
    });

    if (await visitTypeOption.count()) {
      await visitTypeSelect.selectOption({ label: actualVisitType });
    } else {
      console.log(`⚠ Visit type not found: ${actualVisitType} — continuing anyway`);
    }

    // 5️⃣ Fill visit date (MM/DD/YYYY expected)
    const dateParts = visitDate.split('/');

    if (dateParts.length !== 3) {
      console.log(`⚠ Invalid date format: ${visitDate} — skipping`);
      return false;
    }

    await pageA.fill('#VisitDateMonth', dateParts[0].trim());
    await pageA.fill('#VisitDateDay', dateParts[1].trim());
    await pageA.fill('#VisitDateYear', dateParts[2].trim());

    // 6️⃣ 🔎 Therapist check (CRITICAL RULE)
    const therapistField = pageA.locator('#Therapist');

    // If dropdown
    const therapistOption = therapistField.locator('option', {
      hasText: therapist
    });

    const therapistExists = await therapistOption.count();

    if (!therapistExists) {
      console.log(`⏭ Therapist not found in Site A: ${therapist} — skipping visit`);
      
      // Optional: click cancel if form stays open
      const cancelBtn = pageA.locator('input#CancelVisit');
      if (await cancelBtn.count()) {
        await cancelBtn.click();
      }

      return false;
    }

    await therapistField.selectOption({ label: therapist });

    // 7️⃣ Save visit
    const saveButton = pageA.locator('input#SaveVisit');
    await saveButton.click();

    await pageA.waitForLoadState('networkidle');

    console.log(`✅ Added missing visit: ${visitName} on ${visitDate}`);
    return true;

  } catch (error) {
    console.log(`❌ Failed to add visit ${visitName} on ${visitDate}`);
    console.log(error);
    return false;
  }
}