// siteB.actions.ts
import { Page } from 'playwright';
import { Visit, isSOC, isDischarge } from './siteA.actions';
import path from 'path';
import fs from 'fs';

const PATIENT_FILES_DIR = path.join(__dirname, 'patient-files');
if (!fs.existsSync(PATIENT_FILES_DIR)) fs.mkdirSync(PATIENT_FILES_DIR);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const normalize = (s: string) =>
  s.replace(/\s+/g, ' ').replace(/\u00A0/g, ' ').trim().toLowerCase();

function normalizeDateToISO(date: string): string {
  // Accepts "2/17/2026" or "02/17/2026" → "2026-02-17"
  const parts = date.split('/');
  if (parts.length !== 3) return date;
  const [m, d, y] = parts.map(Number);
  return `${y}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
}

/**
 * Build a normalized dedup key from taskName + date only (no therapist —
 * therapist strings differ too much between sites to be reliable).
 * e.g. "pta visit|2026-02-17"
 */
export function normalizeVisitKey(taskName: string, visitDate: string): string {
  return `${normalize(taskName)}|${normalizeDateToISO(visitDate)}`;
}

function normalizeDate(dateStr: string): string {
  // "2/3/2026" → "2/3/2026" (strips leading zeros from month/day)
  const parts = dateStr.split('/');
  if (parts.length !== 3) return dateStr;
  const [month, day, year] = parts;
  return `${parseInt(month)}/${parseInt(day)}/${year}`;
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

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────────────────────────────────────

export async function openPatientsList(pageB: Page) {
  console.log('Opening Patients list in Site B');

  await pageB.locator('a.menu-anchor.primary-menu').waitFor({ state: 'visible', timeout: 10000 });
  await pageB.locator('a.menu-anchor.primary-menu').click();

  await pageB.locator('a.icon-patients.icon').waitFor({ state: 'visible', timeout: 10000 });
  await pageB.locator('a.icon-patients.icon').click();

  const patientsLinks = pageB.locator('a[href^="/Patient/PatientSearch"]');
  await patientsLinks.nth(1).waitFor({ state: 'visible', timeout: 10000 });
  await patientsLinks.nth(1).click();

  await pageB.waitForLoadState('networkidle');
  console.log('Patients list opened successfully');
}

export async function getPatientNames(pageB: Page): Promise<string[]> {
  await pageB.locator('#PatientsTable').waitFor({ state: 'visible' });

  const rows = pageB.locator('#PatientsTable tbody tr');
  const count = await rows.count();

  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = (
      await rows.nth(i).locator('td.sorting_1 a.link-Color').innerText()
    ).trim();
    names.push(name);
  }
  return names;
}

export async function waitForScheduleList(page: Page) {
  const hasRows = async (timeout: number) => {
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('.record-visititem:not(.placeholder)');
      return Array.from(rows).some((r) => (r as HTMLElement).innerText?.trim().length > 0);
    }, { timeout });
  };

  try {
    await page.locator('.record-visititem:not(.placeholder)').first().waitFor({ state: 'visible', timeout: 15000 });
    await hasRows(15000);
  } catch {
    console.log('ℹ Schedule table not ready — navigating back and retrying');
    try {
      await page.goBack();
      await page.waitForLoadState('networkidle');
      await hasRows(15000);
    } catch {
      // Both attempts failed — throw a catchable error so the patient loop can skip gracefully
      throw new Error('SKIP:schedule_list_unavailable');
    }
  }

  console.log('✅ Schedule table fully loaded');
}

// ─────────────────────────────────────────────────────────────────────────────
// VISIT TYPE MAPPING
//
// Site A task name  →  Site B visititem-type text + discipline
//
// The key insight from the HTML:
//   - "PTA Visit" in Site A  →  type="Standard"  discipline="PT"
//   - "COTA Visit" in Site A →  type="Standard"  discipline="OT"
//   - "OT Visit" in Site A   →  type="Standard"  discipline="OT"
//   - "PT Visit" in Site A   →  type="Standard"  discipline="PT"
//   - "Initial Eval" / "OT Evaluation" etc  →  type varies by discipline
// ─────────────────────────────────────────────────────────────────────────────

interface VisitTypeMapping {
  siteBType: string;       // matches .visititem-type text (lowercased)
  discipline: string | null; // matches data-discipline attr (lowercased), null = any
}

const SITE_A_TO_SITE_B: Record<string, VisitTypeMapping> = {
  // Standard visits
  'pt visit':        { siteBType: 'standard', discipline: 'pt' },
  'pta visit':       { siteBType: 'standard', discipline: 'pt' },
  'ot visit':        { siteBType: 'standard', discipline: 'ot' },
  'cota visit':      { siteBType: 'standard', discipline: 'ot' },
  'st visit':        { siteBType: 'standard', discipline: 'st' },
  'standard':        { siteBType: 'standard', discipline: null },

  // Evaluations
  'pt evaluation':   { siteBType: 'initial eval', discipline: 'pt' },
  'ot evaluation':   { siteBType: 'initial eval', discipline: 'ot' },
  'st evaluation':   { siteBType: 'initial eval', discipline: 'st' },
  'initial eval':    { siteBType: 'initial eval', discipline: null },
  'evaluation':      { siteBType: 'initial eval', discipline: null },

  // Re-evaluations / Reassessments
  'pt re-evaluation':   { siteBType: 'reassessment', discipline: 'pt' },
  'ot re-evaluation':   { siteBType: 'reassessment', discipline: 'ot' },
  're-evaluation':      { siteBType: 'reassessment', discipline: null },
  'reassessment':       { siteBType: 'reassessment', discipline: null },

  // Discharge
  'discharge':          { siteBType: 'dc oasis', discipline: null },
  'dc oasis':           { siteBType: 'dc oasis', discipline: null },

  // Recert
  'recertification':    { siteBType: 'recertification', discipline: null },
};

function getSiteBMapping(siteATaskName: string): VisitTypeMapping | null {
  const key = normalize(siteATaskName);
  return SITE_A_TO_SITE_B[key] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// VISIT STATUS RESOLUTION
//
// The HTML structure is:
//   <div class="record-visititem" data-discipline="PT">
//     <a href="/Visit/VisitDetail/...">
//       <span class="visititem-type">Standard</span>
//       <span class="record-visit-date">2/17/2026</span>
//       <span class="small-font">2:30 PM</span>
//       <span class="underline ">Incomplete</span>   ← status is HERE
//     </a>
//   </div>
//
// NOT inside a <tr>. The old code used pageB.locator('tr', ...) — that's why
// it always returned NOT_FOUND.
// ─────────────────────────────────────────────────────────────────────────────

export type ScheduleResult = 'SCHEDULED' | 'INCOMPLETE' | 'VIEW_DOCUMENT' | 'NOT_FOUND';

/**
 * Find the Site B visit card that matches taskName + visitDate and return its
 * schedule status span text.
 *
 * taskName here is the Site B visititem-type text (e.g. "Standard", "SOC OASIS").
 * visitDate is MM/DD/YYYY or M/D/YYYY.
 */
export async function resolveScheduleForVisit(
  pageB: Page,
  visit: { taskName: string; visitDate: string }
): Promise<ScheduleResult> {

  // Skip discharge visits entirely
  if (isDischarge(visit.taskName)) {
    console.log(`  ⏭ resolveScheduleForVisit: skipping Discharge — "${visit.taskName}"`);
    return 'NOT_FOUND';
  }

  const expectedDate = normalizeDate(visit.visitDate);

  // Translate Site A task name to Site B type + discipline, same as openVisitInSchedule
  const mapping            = getSiteBMapping(visit.taskName);
  const expectedType       = mapping?.siteBType ?? normalize(visit.taskName);
  const expectedDiscipline = mapping?.discipline ?? null;

  console.log(`  resolveSchedule: looking for type="${expectedType}" discipline="${expectedDiscipline ?? 'any'}" date="${expectedDate}"`);

  const items = pageB.locator('.record-visititem:not(.placeholder)');
  const count = await items.count();

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);

    // Visit type
    const typeEl = item.locator('.visititem-type');
    if (!(await typeEl.count())) continue;
    const itemType = normalize(await typeEl.innerText());

    // Date
    const dateEl = item.locator('span.record-visit-date');
    if (!(await dateEl.count())) continue;
    const itemDate = normalizeDate((await dateEl.first().innerText()).trim());

    if (itemType !== expectedType || itemDate !== expectedDate) continue;

    // Discipline check - distinguishes PT Standard from OT Standard etc.
    if (expectedDiscipline) {
      const discipline = normalize(await item.getAttribute('data-discipline') ?? '');
      if (discipline !== expectedDiscipline) continue;
    }

    // Status span — last span with class "underline" (or "link-Color underline")
    // Could also be a span without "underline" class (e.g. "View Documents" uses link-Color)
    const statusEl = item.locator('a span.underline, a span.link-Color.underline');
    if (!(await statusEl.count())) {
      console.log(`  ⚠ No status span found for ${visit.taskName} ${visit.visitDate}`);
      return 'NOT_FOUND';
    }

    const rawStatus = normalize(await statusEl.first().innerText());
    console.log(`🔎 Status for "${visit.taskName}" ${visit.visitDate}: "${rawStatus}"`);

    if (rawStatus.includes('scheduled')) return 'SCHEDULED';
    if (rawStatus.includes('incomplete')) return 'INCOMPLETE';
    if (rawStatus.includes('view')) return 'VIEW_DOCUMENT';

    return 'NOT_FOUND';
  }

  console.log(`  ⚠ Visit card not found for ${visit.taskName} ${visit.visitDate}`);
  return 'NOT_FOUND';
}

// ─────────────────────────────────────────────────────────────────────────────
// OPEN VISIT IN SITE B SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduleTimes {
  timeIn: string;
  timeOut: string;
  documents: string[];
  siteBStatus: string;   // raw status text from Site B, e.g. "missed (completed)", "incomplete"
}

/**
 * Find a visit card in Site B by Site A task name + date, click it,
 * wait for the detail page, then return timeIn/timeOut.
 */
export async function openVisitInSchedule(
  pageB: Page,
  siteAVisitName: string,   // e.g. "PTA Visit", "COTA Visit", "OT Evaluation"
  visitDate: string,         // MM/DD/YYYY
  therapist?: string
): Promise<ScheduleTimes> {

  console.log(`Looking for "${siteAVisitName}" on ${visitDate}`);

  if (!visitDate || siteAVisitName.toLowerCase().startsWith('del')) {
    throw new Error(`Skipped invalid visit: ${siteAVisitName}`);
  }

  const mapping = getSiteBMapping(siteAVisitName);
  const expectedType  = mapping?.siteBType ?? normalize(siteAVisitName);
  const expectedDiscipline = mapping?.discipline ?? null;
  const expectedDate = normalizeDate(visitDate);

  console.log(`  Mapped to Site B type="${expectedType}" discipline="${expectedDiscipline ?? 'any'}"`);

  await pageB.waitForSelector('.record-visititem:not(.placeholder)', { timeout: 15000 });

  const items = pageB.locator('.record-visititem:not(.placeholder)');
  const count = await items.count();

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);

    // ── Type ────────────────────────────────────────────────────────────────
    const typeEl = item.locator('.visititem-type');
    if (!(await typeEl.count())) continue;
    const itemType = normalize(await typeEl.innerText());
    if (itemType !== expectedType) continue;

    // ── Date ────────────────────────────────────────────────────────────────
    const dateEl = item.locator('span.record-visit-date');
    if (!(await dateEl.count())) continue;
    const itemDate = normalizeDate((await dateEl.first().innerText()).trim());
    if (itemDate !== expectedDate) continue;

    // ── Discipline ──────────────────────────────────────────────────────────
    if (expectedDiscipline) {
      const discipline = normalize(await item.getAttribute('data-discipline') ?? '');
      if (discipline !== expectedDiscipline) continue;
    }

    // ── Therapist (optional) ────────────────────────────────────────────────
    if (therapist) {
      const therapistText = normalize(
        await item.locator('.record-visit-therapists').innerText()
      );
      // Partial match: "j. diaz" should match "jessica diaz (pta)"
      const therapistKey = normalize(therapist).replace(/\s*\(.*\)/, '');
      if (!therapistText.includes(therapistKey.split(' ').pop() ?? '')) {
        // Only warn — don't skip if last name matches
        console.log(`  ⚠ Therapist partial mismatch: expected "${therapist}", found "${therapistText}"`);
      }
    }

    console.log(`✅ MATCH FOUND: type="${itemType}" date="${itemDate}" discipline="${await item.getAttribute('data-discipline')}"`);

    // ── Capture status before clicking ──────────────────────────────────────
    const statusEl = item.locator('a span.underline, a span.link-Color.underline');
    const siteBStatus = (await statusEl.count())
      ? normalize(await statusEl.first().innerText())
      : '';

    // ── Check for "No Scheduled Time" before clicking ────────────────────────
    const timeSpan = item.locator('span.small-font');
    if (await timeSpan.count()) {
      const timeText = normalize(await timeSpan.innerText());
      if (timeText.includes('no scheduled')) {
        throw new Error(`SKIP:no_scheduled_time — ${siteAVisitName} ${visitDate}`);
      }
    }

    // ── Click the visit detail link ──────────────────────────────────────────
    const link = item.locator('a[href*="/Visit/VisitDetail"]');
    await link.click();
    await pageB.waitForLoadState('networkidle');

    // ── Grab scheduled time from detail page ────────────────────────────────
    const { visitDate: detailDate, timeIn, timeOut } = await getVisitDateAndTimesFromSiteB(pageB);

    console.log(`  ↳ Time In: ${timeIn} | Time Out: ${timeOut} | Date: ${detailDate}`);

    return { timeIn, timeOut, documents: [], siteBStatus };
  }

  // ── Debug dump on failure ────────────────────────────────────────────────
  console.log(`❌ Visit not found in Site B: "${siteAVisitName}" on ${visitDate}`);
  console.log(`   Expected type="${expectedType}" discipline="${expectedDiscipline}" date="${expectedDate}"`);

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const typeEl = item.locator('.visititem-type');
    const dateEl = item.locator('span.record-visit-date');
    const discipline = await item.getAttribute('data-discipline');
    const t = (await typeEl.count()) ? normalize(await typeEl.innerText()) : '(no type)';
    const d = (await dateEl.count()) ? normalizeDate((await dateEl.first().innerText()).trim()) : '(no date)';
    console.log(`   Row ${i}: type="${t}" date="${d}" discipline="${discipline}"`);
  }

  throw new Error(`Visit not found in Site B: ${siteAVisitName} ${visitDate}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXTRACT TIMES FROM VISIT DETAIL PAGE
// ─────────────────────────────────────────────────────────────────────────────

export async function getVisitDateAndTimesFromSiteB(pageB: Page) {
  // Try structured input fields first (edit mode).
  // Use select[id="HourIn"] to avoid strict-mode collision with the hidden input.
  const hourInCount = await pageB.locator('select#HourIn').count();

  if (hourInCount > 0) {
    const timeInHour  = await pageB.locator('select#HourIn').inputValue();
    const timeInMin   = await pageB.locator('select#MinuteIn').inputValue();
    const timeInAmPm  = await pageB.locator('select#AmPmIn').inputValue();
    const timeOutHour = await pageB.locator('select#HourOut').inputValue();
    const timeOutMin  = await pageB.locator('select#MinuteOut').inputValue();
    const timeOutAmPm = await pageB.locator('select#AmPmOut').inputValue();

    const visitDate = (
      await pageB.locator('.form-input-wrapper label')
        .filter({ hasText: '/' })
        .last()
        .innerText()
    ).trim();

    return {
      visitDate,
      timeIn:  `${timeInHour}:${timeInMin} ${timeInAmPm}`,
      timeOut: `${timeOutHour}:${timeOutMin} ${timeOutAmPm}`,
    };
  }

  // Fallback: read the display text from the schedule card
  // e.g. <span class="small-font cursor-pointer">2:30 PM</span>
  const timeSpans = await pageB.locator('.small-font.cursor-pointer').allInnerTexts();
  const validTimes = timeSpans.filter(
    (t) => /\d+:\d+\s*(AM|PM)/i.test(t) || /\d+\s*(AM|PM)/i.test(t)
  );

  const timeIn  = validTimes[0] ?? '';
  const timeOut = validTimes[1] ?? validTimes[0] ?? '';

  // Date: look for a span that contains a date pattern
  const dateSpans = await pageB.locator('span.record-visit-date').allInnerTexts();
  const visitDate = dateSpans[0]?.trim() ?? '';

  return { visitDate, timeIn, timeOut };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL SITE B VISITS FOR A PATIENT (used for missing-visit detection)
// ─────────────────────────────────────────────────────────────────────────────

export async function getSiteBVisitsForPatient(
  pageB: Page,
  patientName: string
): Promise<Visit[]> {
  console.log(`📄 Fetching Site B visits for patient: ${patientName}`);

  await pageB.waitForSelector('.record-visititem:not(.placeholder)', { timeout: 10000 });

  const items = pageB.locator('.record-visititem:not(.placeholder)');
  const count = await items.count();

  const visits: Visit[] = [];

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);

    // Visit type
    const typeEl = item.locator('.visititem-type');
    if (!(await typeEl.count())) continue;
    const typeText = (await typeEl.innerText()).trim();

    // Skip SOC and Discharge visits
    if (isSOC(typeText) || isDischarge(typeText)) {
      console.log(`  Site B row ${i}: skipped (SOC or Discharge) — "${typeText}"`);
      continue;
    }

    // Discipline
    const discipline = (await item.getAttribute('data-discipline') ?? '').toUpperCase();

    // Therapist — inside .record-visit-therapists
    const therapistEl = item.locator('.record-visit-therapists');
    const therapistText = (await therapistEl.count())
      ? (await therapistEl.innerText()).trim()
      : 'Unknown';

    // Date — span.record-visit-date (NOT small-font which is time)
    const dateEl = item.locator('span.record-visit-date');
    if (!(await dateEl.count())) continue;
    const visitDate = normalizeDate((await dateEl.first().innerText()).trim());

    // Status + time
    const statusEl = item.locator('a span.underline, a span.link-Color.underline');
    const statusText = (await statusEl.count())
      ? normalize(await statusEl.first().innerText())
      : '';

    // Time span — "No Scheduled Time" means skip entirely
    const timeEl = item.locator('span.small-font');
    const timeText = (await timeEl.count())
      ? normalize(await timeEl.innerText())
      : '';

    if (timeText.includes('no scheduled')) {
      console.log(`  Site B row ${i}: skipped (no scheduled time) — "${typeText}" ${visitDate}`);
      continue;
    }

    // Map Site B type → Site A equivalents
    let actualVisitType = 'Standard';
    let siteBVisitName  = typeText;

    const typeNorm = normalize(typeText);
    if (/initial eval/i.test(typeNorm))      actualVisitType = 'Evaluation';
    else if (/reassessment/i.test(typeNorm)) actualVisitType = 'Reassessment';
    else if (/discharge|dc oasis/i.test(typeNorm)) actualVisitType = 'Discharge';
    else if (/recert/i.test(typeNorm))       actualVisitType = 'Recertification';
    else if (/soc/i.test(typeNorm))          actualVisitType = 'SOC';

    // Derive a Site-A-style task name from type + discipline
    // e.g. Standard + PT → "PTA Visit", Standard + OT → "COTA Visit"
    if (/standard/i.test(typeNorm)) {
      if (discipline === 'PT')      siteBVisitName = 'PTA Visit';
      else if (discipline === 'OT') siteBVisitName = 'COTA Visit';
      else if (discipline === 'ST') siteBVisitName = 'ST Visit';
      else                          siteBVisitName = 'Standard';
    } else if (/initial eval/i.test(typeNorm)) {
      siteBVisitName = `${discipline} Evaluation`;
    } else if (/reassessment/i.test(typeNorm)) {
      siteBVisitName = `${discipline} Re-Evaluation`;
    }

    console.log(
      `  Site B row ${i}: type="${typeText}" discipline="${discipline}" date="${visitDate}" status="${statusText}" therapist="${therapistText}"`
    );

    visits.push({
      taskName:       siteBVisitName,
      therapist:      therapistText,
      visitDate,
      targetDate:     visitDate,
      siteBVisitName: typeText,   // keep the raw Site B type for matching
      rowIndex:       i,
      needsAction:    statusText !== 'view documents',  // already complete if "View Documents"
      actualVisitType,
    });
  }

  console.log(`✅ Found ${visits.length} visit(s) in Site B for patient ${patientName}`);
  return visits;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT DOWNLOAD
//
// Filename format: visitName-date-patientName-N.pdf
// Skips any file that already exists in patient-files/.
// Uses the ViewNote onclick URL directly to navigate to the printable page.
// ─────────────────────────────────────────────────────────────────────────────

export async function downloadVisitFiles(
  pageB: Page,
  visitName: string,   // e.g. "PTA Visit"
  visitDate: string,   // e.g. "02/17/2026"
  patientName: string  // e.g. "Flores, Marlene"
): Promise<string[]> {
  const downloadedFiles: string[] = [];

  // ── Sanitize filename parts ──────────────────────────────────────────────
  // Kinser only allows: letters, numbers, spaces, dashes, parentheses, underscores, periods
  const safe = (s: string) => s
    .replace(/,/g, '')
    .replace(/[^A-Za-z0-9 \-_(). ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const safeDatePart = visitDate.replace(/\//g, '-');  // 02/17/2026 → 02-17-2026
  const fileBase     = `${safe(visitName)}-${safeDatePart}-${safe(patientName)}`;

  // ── Fuzzy duplicate check: scan existing files for same visit+date ───────
  // Old files may have had commas in names. Match on normalized date + visit type.
  const fuzzyKey = `${safe(visitName).toLowerCase()}-${safeDatePart}`.replace(/\s+/g, '-');
  const existingFiles = fs.existsSync(PATIENT_FILES_DIR)
    ? fs.readdirSync(PATIENT_FILES_DIR)
    : [];
  const alreadyDownloaded = existingFiles.filter(f => {
    const norm = f.toLowerCase().replace(/,/g, '').replace(/\s+/g, '-');
    return norm.includes(fuzzyKey);
  });

  // ── Wait for notes section ───────────────────────────────────────────────
  const notesSection = pageB.locator('#VisitDetailNotes');
  try {
    await notesSection.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    console.log(`  ℹ No #VisitDetailNotes section found — skipping download`);
    return [];
  }

  const noteItems = pageB.locator('#VisitDetailNotes .divNoteItem');
  const noteCount = await noteItems.count();

  if (noteCount === 0) {
    console.log(`  ℹ No note items found for visit: ${visitName}`);
    return [];
  }

  for (let i = 0; i < noteCount; i++) {
    const note = noteItems.nth(i);

    // ── Check for View button ────────────────────────────────────────────
    const viewButton = note.locator('button.green-button.uppercase');
    if (!(await viewButton.count())) continue;

    // ── Get the note label for logging ───────────────────────────────────
    const labelEl = note.locator('.section-header label');
    const noteLabel = (await labelEl.count())
      ? (await labelEl.innerText()).trim()
      : `Note ${i + 1}`;

    // ── Build target PDF path ─────────────────────────────────────────────
    const pdfPath = path.join(PATIENT_FILES_DIR, `${fileBase}-${i + 1}.pdf`);

    // ── Skip if already downloaded (fuzzy match on visit+date pattern) ────
    const fuzzyMatch = alreadyDownloaded.find(f =>
      f.toLowerCase().includes(`-${i + 1}.pdf`)
    );
    if (fuzzyMatch || fs.existsSync(pdfPath)) {
      const existingPath = path.join(PATIENT_FILES_DIR, fuzzyMatch ?? path.basename(pdfPath));
      console.log(`  ⏭ Already exists, skipping: ${fuzzyMatch ?? path.basename(pdfPath)}`);
      downloadedFiles.push(fs.existsSync(pdfPath) ? pdfPath : existingPath);
      continue;
    }

    // ── Extract ViewNote URL from onclick attr ────────────────────────────
    // onclick="ViewNote('/Note/GetPrintable?noteId=809066')"
    const onclickAttr = await viewButton.getAttribute('onclick') ?? '';
    const urlMatch = onclickAttr.match(/ViewNote\(['"]([^'"]+)['"]\)/);

    if (!urlMatch) {
      console.log(`  ⚠ Could not parse ViewNote URL for "${noteLabel}" — skipping`);
      continue;
    }

    const noteUrl = urlMatch[1]; // e.g. "/Note/GetPrintable?noteId=809066"

    // ── Open printable page in new tab ───────────────────────────────────
    const currentBaseUrl = new URL(pageB.url());
    const printableUrl = `${currentBaseUrl.origin}${noteUrl}`;

    const newPage = await pageB.context().newPage();
    try {
      await newPage.goto(printableUrl, { waitUntil: 'load', timeout: 15000 });
      await newPage.pdf({ path: pdfPath, format: 'A4' });
      downloadedFiles.push(pdfPath);
      console.log(`  ✅ Downloaded: ${path.basename(pdfPath)} ("${noteLabel}")`);
    } catch (err: any) {
      console.log(`  ⚠ Failed to download "${noteLabel}": ${err.message}`);
    } finally {
      await newPage.close();
    }
  }

  if (downloadedFiles.length === 0) {
    console.log(`  ℹ No PDFs downloaded for visit: ${visitName}`);
  } else {
    console.log(`  ✅ Total PDFs for this visit: ${downloadedFiles.length}`);
  }

  return downloadedFiles;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY / UNUSED — kept for API compatibility
// ─────────────────────────────────────────────────────────────────────────────

export async function getScheduleStatus(
  pageB: Page,
  discipline: string,
  visitType: string,
  visitDate: string
) {
  const row = pageB.locator(`.record-visititem[data-discipline="${discipline}"]`);
  const status = await row.locator('span').first().innerText();
  return { row, status };
}

export async function getVisitTimes(pageB: Page, row: any) {
  const timeIn    = await row.locator('.record-visit-date').first().innerText();
  const timeOut   = await row.locator('.record-visit-date').nth(1).innerText();
  const visitDate = await row.locator('.record-visit-date').first().innerText();
  return { visitDate, timeIn, timeOut };
}

export async function printOtherDocuments(pageB: Page) {
  const docButtons = pageB.locator('.divNoteItem button:has-text("View")');
  const count = await docButtons.count();
  for (let i = 0; i < count; i++) {
    await docButtons.nth(i).click();
    console.log('Sent document to printer');
    await pageB.goBack();
  }
}

export const VISIT_TYPE_MAP: Record<string, string[]> = {
  'OT Evaluation':    ['initial eval'],
  'PT Evaluation':    ['initial eval'],
  'ST Evaluation':    ['initial eval'],
  'PT Re-Evaluation': ['reassessment'],
  'OT Re-Evaluation': ['reassessment'],
  'COTA Visit':       ['standard'],
  'PTA Visit':        ['standard'],
  'OT Visit':         ['standard'],
  'PT Visit':         ['standard'],
};