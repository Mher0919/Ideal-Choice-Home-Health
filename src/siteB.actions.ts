// siteB.actions.ts
import { Page } from 'playwright';
import { Visit } from './siteA.actions';
import path from 'path';
import fs from 'fs';

const PATIENT_FILES_DIR = path.join(__dirname, 'patient-files');

export async function openPatientsList(pageB: Page) {
  console.log('Opening Patients list in Site B');

  // STEP 1 — Open top menu
  await pageB
    .locator('a.menu-anchor.primary-menu')
    .waitFor({ state: 'visible', timeout: 10000 });

  await pageB.locator('a.menu-anchor.primary-menu').click();

  // STEP 2 — Click first "Patients" (icon menu)
  await pageB
    .locator('a.icon-patients.icon')
    .waitFor({ state: 'visible', timeout: 10000 });

  await pageB.locator('a.icon-patients.icon').click();

  // STEP 3 — Click second "Patients" (submenu)
  const patientsLinks = pageB.locator(
    'a[href^="/Patient/PatientSearch"]'
  );

  await patientsLinks.nth(1).waitFor({ state: 'visible', timeout: 10000 });
  await patientsLinks.nth(1).click();

  // STEP 4 — Wait for patient table/page
  await pageB.waitForLoadState('networkidle');

  console.log('Patients list opened successfully');
}

export async function getPatientNames(pageB: Page): Promise<string[]> {
  await pageB.locator('#PatientsTable').waitFor({ state: 'visible' });

  const rows = pageB.locator('#PatientsTable tbody tr');
  const count = await rows.count();

  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = (await rows.nth(i)
      .locator('td.sorting_1 a.link-Color')
      .innerText()).trim();
    names.push(name);
  }
  return names;
}

/* -------------------- SCHEDULE RESOLUTION -------------------- */

export type ScheduleResult = 'SCHEDULED' | 'INCOMPLETE' | 'VIEW_DOCUMENT' | 'NOT_FOUND';

export async function resolveScheduleForVisit(
  pageB: Page,
  visit: { taskName: string; visitDate: string }
): Promise<'SCHEDULED' | 'INCOMPLETE' | 'VIEW_DOCUMENT' | 'NOT_FOUND'> {

  // Locate the row for this visit
  const visitRow = pageB.locator('tr', {
    hasText: visit.taskName
  }).filter({
    hasText: visit.visitDate
  });

  if (!(await visitRow.count())) {
    return 'NOT_FOUND';
  }

  // 🔎 Look for status span inside that row
  const statusSpan = visitRow.locator('span');

  if (!(await statusSpan.count())) {
    return 'NOT_FOUND';
  }

  const rawStatus = (await statusSpan.first().innerText()).trim().toLowerCase();

  console.log(`🔎 Status detected for ${visit.taskName}: "${rawStatus}"`);

  if (rawStatus.includes('scheduled')) {
    return 'SCHEDULED';
  }

  if (rawStatus.includes('incomplete')) {
    return 'INCOMPLETE';
  }

  if (rawStatus.includes('view')) {
    return 'VIEW_DOCUMENT';
  }

  return 'NOT_FOUND';
}

/**
 * Get the schedule status for a specific visit
 */
export async function getScheduleStatus(
  pageB: Page,
  discipline: string,
  visitType: string,
  visitDate: string
) {
  // Find the row with matching discipline + type + date
  const row = pageB.locator(`.record-visititem[data-discipline="${discipline}"]`);
  const status = await row.locator('span').first().innerText(); // SCHEDULED / INCOMPLETE / VIEW DOCUMENT
  return { row, status };
}

/**
 * Get time in/out and date for a schedule in Site B
 */
export async function getVisitTimes(pageB: Page, row: any) {
  const timeIn = await row.locator('.record-visit-date').first().innerText(); // e.g., "2/3/2026 1PM"
  const timeOut = await row.locator('.record-visit-date').nth(1).innerText(); // adjust if needed
  const visitDate = await row.locator('.record-visit-date').first().innerText();

  return { visitDate, timeIn, timeOut };
}

/**
 * Process all documents for Standard Visits (download PDFs)
 */
if (!fs.existsSync(PATIENT_FILES_DIR)) fs.mkdirSync(PATIENT_FILES_DIR);

export async function downloadVisitFiles(
  pageB: Page,
  visitName: string,
  visitDate: string,
  patientName: string
): Promise<string[]> {
  const downloadedFiles: string[] = [];

  // Normalize file name parts
  const safeVisitName = visitName.replace(/[\/\\:*?"<>|]/g, '');
  const safePatientName = patientName.replace(/[\/\\:*?"<>|]/g, '');
  const safeFileBase = `${visitDate}-${safeVisitName}-${safePatientName}`;

  // Wait for notes section
  await pageB.waitForSelector('#VisitDetailNotes', { timeout: 5000 });

  const noteItems = pageB.locator('#VisitDetailNotes .divNoteItem');
  const noteCount = await noteItems.count();

  for (let i = 0; i < noteCount; i++) {
    const note = noteItems.nth(i);

    // Check if there is a View button
    const viewButton = note.locator('button.green-button.uppercase');
    if ((await viewButton.count()) === 0) continue;

    // Click the View button (opens printable PDF)
    const [newPage] = await Promise.all([
      pageB.context().waitForEvent('page'),
      viewButton.click(),
    ]);

    await newPage.waitForLoadState('load');

    // Build PDF path
    const pdfPath = path.join(PATIENT_FILES_DIR, `${safeFileBase}-${i + 1}.pdf`);

    // Save page as PDF
    await newPage.pdf({ path: pdfPath, format: 'A4' });
    downloadedFiles.push(pdfPath);

    console.log(`✅ Downloaded PDF: ${pdfPath}`);
    await newPage.close();
  }

  if (downloadedFiles.length === 0) {
    console.log(`ℹ No PDFs found for visit: ${visitName}`);
  }

  return downloadedFiles;
}

/**
 * Process documents for non-Standard visits (print to printer)
 */
export async function printOtherDocuments(pageB: Page) {
  const docButtons = pageB.locator('.divNoteItem button:has-text("View")');
  const count = await docButtons.count();

  for (let i = 0; i < count; i++) {
    await docButtons.nth(i).click();
    console.log('Sent document to printer (manual action required if needed)');
    await pageB.goBack();
  }
}

export interface ScheduleTimes {
    timeIn: string;
    timeOut: string;
    documents: string[]; // paths of PDFs downloaded
}
/**
 * Normalize dates to MM/DD/YYYY string
 */
function normalizeDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr; // fallback
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const year = d.getFullYear();
  return `${month}/${day}/${year}`;
}

/**
 * Convert AM/PM time string to 24h format HH:mm
 */
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

function normalizeDateToISO(date: string): string {
  const [m, d, y] = date.split('/').map(Number);
  return `${y}-${m.toString().padStart(2, '0')}-${d
    .toString()
    .padStart(2, '0')}`;
}
/**
 * Find and click the exact visit in Site B schedule, return the times and document links
 */

export const VISIT_TYPE_MAP: Record<string, string[]> = {
  'OT Evaluation': ['initial eval'],
  'PT Evaluation': ['initial eval'],
  'ST Evaluation': ['initial eval'],

  'PT Re-Evaluation': ['reassessment'],
  'OT Re-Evaluation': ['reassessment'],

  'COTA Visit': ['standard'],
  'PTA Visit': ['standard'],
  'OT Visit': ['standard'],
  'PT Visit': ['standard'],
};

export async function openVisitInSchedule(
  pageB: Page,
  visitName: string,
  visitDate: string,
  therapist?: string
) {
  console.log(`Looking for "${visitName}" on ${visitDate}`);

  if (!visitDate || visitName.toLowerCase().startsWith('del')) {
    throw new Error(`Skipped invalid visit: ${visitName}`);
  }

  const normalize = (s: string) =>
    s.replace(/\s+/g, ' ').trim().toLowerCase();

  const expectedDate = normalizeDateToISO(visitDate);

  // --- Map taskName to expected types ---
  const expectedTypes = VISIT_TYPE_MAP[visitName] || [visitName.toLowerCase()];

  await pageB.waitForSelector('.record-visititem:not(.placeholder)', {
    timeout: 15000,
  });

  const items = pageB.locator('.record-visititem:not(.placeholder)');
  const count = await items.count();

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);

    const visitType = normalize(
      await item.locator('.visititem-type').innerText()
    );

    const rawDate = await item.locator('.record-visit-date').innerText();
    const visitDateISO = normalizeDateToISO(rawDate);

    const discipline = normalize(await item.getAttribute('data-discipline') || '');

    // ---- Matching ----
    if (visitDateISO !== expectedDate) continue;

    if (!expectedTypes.includes(visitType)) continue; // <-- allow initial/reassessment/standard

    const expectedDiscipline =
      visitName.toLowerCase().includes('cota') ? 'ot'
      : visitName.toLowerCase().includes('pta') ? 'pt'
      : null;

    if (expectedDiscipline && discipline !== expectedDiscipline) continue;

    console.log('✅ MATCH FOUND');

    await item.locator('a[href*="/Visit/VisitDetail"]').click();
    await pageB.waitForLoadState('networkidle');

    const times = await pageB
      .locator('.small-font.cursor-pointer')
      .allInnerTexts();

    let timeIn = '';
    let timeOut = '';

    if (times.length === 1 && !times[0].includes('No Scheduled')) {
      timeIn = timeOut = times[0];
    }

    return { timeIn, timeOut, documents: [] };
  }

  throw new Error(`Visit not found: ${visitName} ${visitDate}`);
}

export async function getVisitDateAndTimesFromSiteB(pageB: Page) {
  const timeInHour = await pageB.locator('#HourIn').inputValue();
  const timeInMin = await pageB.locator('#MinuteIn').inputValue();
  const timeInAmPm = await pageB.locator('#AmPmIn').inputValue();

  const timeOutHour = await pageB.locator('#HourOut').inputValue();
  const timeOutMin = await pageB.locator('#MinuteOut').inputValue();
  const timeOutAmPm = await pageB.locator('#AmPmOut').inputValue();

  const visitDate = (
    await pageB.locator('.form-input-wrapper label')
      .filter({ hasText: '/' })
      .last()
      .innerText()
  ).trim(); // e.g. 1/13/2026

  const timeIn = `${timeInHour}:${timeInMin} ${timeInAmPm}`;
  const timeOut = `${timeOutHour}:${timeOutMin} ${timeOutAmPm}`;

  return { visitDate, timeIn, timeOut };
}


// Helper
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export async function waitForScheduleList(page: Page) {
  const scheduleRows = page.locator('.record-visititem:not(.placeholder)');

  try {
    // Wait for at least one visible row with text content
    await scheduleRows.first().waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('.record-visititem:not(.placeholder)');
      return Array.from(rows).some(r => r.textContent?.trim().length > 0);
    }, { timeout: 15000 });
  } catch {
    console.log('ℹ Schedule table not ready — navigating back and retrying');
    await page.goBack();  // go back to schedule list
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('.record-visititem:not(.placeholder)');
      return Array.from(rows).some(r => r.textContent?.trim().length > 0);
    }, { timeout: 15000 });
  }

  console.log('✅ Schedule table fully loaded');
}

export async function getSiteBVisitsForPatient(pageB: Page, patientName: string): Promise<Visit[]> {
  console.log(`📄 Fetching Site B visits for patient: ${patientName}`);

  // Wait for schedule items to load
  await pageB.waitForSelector('.record-visititem:not(.placeholder)', { timeout: 10000 });

  const items = pageB.locator('.record-visititem:not(.placeholder)');
  const count = await items.count();

  const visits: Visit[] = [];

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);

    // Visit type / task name
    const typeText = (await item.locator('.visititem-type').innerText()).trim();

    // Therapist
    const therapistText = (await item.locator('.record-visit-therapists').innerText()).trim();

    // Date
    const rawDate = (await item.locator('.record-visit-date').innerText()).trim(); // e.g., "2/15/2026"
    const visitDate = rawDate; // keep MM/DD/YYYY

    // Determine standard type mapping
    let actualVisitType = 'Standard';
    if (/initial eval/i.test(typeText)) actualVisitType = 'Evaluation';
    else if (/reassessment/i.test(typeText)) actualVisitType = 'Reassessment';
    else if (/discharge/i.test(typeText)) actualVisitType = 'Discharge';
    else if (/recert/i.test(typeText)) actualVisitType = 'Recertification';
    else if (/cota/i.test(typeText)) actualVisitType = 'COTA';

    // Map to Site B visit name
    let siteBVisitName = typeText;
    if (/standard/i.test(typeText)) siteBVisitName = 'Visit';
    else if (/initial eval/i.test(typeText)) siteBVisitName = 'Evaluation';
    else if (/reassessment/i.test(typeText)) siteBVisitName = 'Re-Evaluation';
    else if (/cota/i.test(typeText)) siteBVisitName = 'COTA Visit';

    visits.push({
      taskName: typeText,
      therapist: therapistText || 'Unknown',
      visitDate,
      targetDate: visitDate,
      siteBVisitName,
      rowIndex: i,
      needsAction: true,
      actualVisitType
    });
  }

  console.log(`✅ Found ${visits.length} visit(s) in Site B for patient ${patientName}`);
  return visits;
}
