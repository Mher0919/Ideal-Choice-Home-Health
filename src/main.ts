// main.ts
import * as dotenv from 'dotenv';
dotenv.config();

import { chromium } from 'playwright';
import { runSiteA } from './siteA';
import { runSiteB } from './siteB';

import {
  openPatientManager,
  clickLetterInPatientManager,
  clickPatientByName,
  openAllTherapyTab,
  getAllIncompleteVisits,
  fillVisitDateAndTimesInSiteA,
  approveVisit,
  uploadAttachment,
  updateTask,
  clickDetailsInSiteA,
  Visit,
  checkVisitDateAndTimesFilled,
  openVisitFromViewMenu,
  addMissingVisitInSiteA,
  isSOC
} from './siteA.actions';

import {
  downloadVisitFiles,
  getSiteBVisitsForPatient,
  getVisitDateAndTimesFromSiteB,
  openPatientsList,
  openVisitInSchedule,
  resolveScheduleForVisit,
  waitForScheduleList,
} from './siteB.actions';

import path from 'path';

function normalizeText(str: string): string {
  return str
    .replace(/\s+/g, ' ')        // collapse all whitespace
    .replace(/\u00A0/g, ' ')     // replace non-breaking spaces
    .replace(/[^\x00-\x7F]/g, '') // remove other non-ASCII if needed
    .trim()
    .toLowerCase();
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const pageA = await runSiteA(browser);
  const pageB = await runSiteB(browser);

  await openPatientManager(pageA);
  await openPatientsList(pageB);

  const patientNames: string[] = [];
  const patientRows = pageB.locator('#PatientsTable tbody tr');
  const patientCount = await patientRows.count();
  for (let i = 0; i < patientCount; i++) {
    const name = (await patientRows.nth(i).locator('td.sorting_1 a.link-Color').innerText()).trim();
    patientNames.push(name);
  }
  console.log(`Total patients in Site B: ${patientNames.length}`);

  // --- Loop through all patients in Site B ---
  // --- Loop through all patients in Site B ---
for (let i = 0; i < patientNames.length; i++) {
  const patientName = patientNames[i];
  console.log(`\n▶ Processing patient [${i + 1}/${patientNames.length}]: ${patientName}`);

  // --- Switch to Site A ---
  await pageA.bringToFront();
  await openPatientManager(pageA);

  let patientOpened = false;
  try {
    await clickLetterInPatientManager(pageA, patientName);
    await clickPatientByName(pageA, patientName);
    patientOpened = true;
  } catch {
    console.log(`⚠ Patient "${patientName}" not found in Site A, skipping.`);
    continue;
  }
  if (!patientOpened) continue;

  // --- Open All Therapy tab ---
  await openAllTherapyTab(pageA);
  // Wait for the table itself (optional, keeps original check)
  const therapyTable = pageA.locator('table#scheduled-task');
  try {
    await therapyTable.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    console.log(`⚠ No visits found for patient "${patientName}", skipping.`);
    continue;
  }

  // --- Get all incomplete visits ---
  const visits = await getAllIncompleteVisits(pageA);
  if (visits.length === 0) {
    console.log(`✓ No actionable visits for patient "${patientName}"`);
    await pageB.bringToFront();
    continue;
  }

  // --- Remove duplicates ---
  const uniqueVisits = Array.from(
    new Map(visits.map(v => [`${v.taskName}-${v.visitDate}-${v.therapist}`, v])).values()
  );
  console.log(`Found ${uniqueVisits.length} unique incomplete visit(s) for patient "${patientName}"`);

  // --- Open patient page in Site B ---
  await pageB.bringToFront();
  const patientLink = pageB.locator(`#PatientsTable tbody tr td.sorting_1 a.link-Color`, { hasText: patientName });
  try {
    await patientLink.click();
    await pageB.waitForLoadState('networkidle');
    console.log(`Opened patient page in Site B: ${patientName}`);
  } catch {
    console.log(`⚠ Could not open patient page in Site B: ${patientName}, skipping visits.`);
    continue;
  }

  const actionableVisits = uniqueVisits.filter(v =>
    v.needsAction &&
    v.taskName?.trim() &&
    v.visitDate?.trim()
  );

  for (const visit of actionableVisits) {
    const normalizedTaskName = visit.taskName.replace(/\s+/g, ' ').trim();
    const normalizedVisitDate = visit.visitDate.trim();

    console.log(`➡ Processing visit: ${normalizedTaskName} on ${normalizedVisitDate} with ${visit.therapist || 'Unknown therapist'}`);

    try {
      // <-- INSERT CHECK/NAVIGATION HERE BEFORE opening the visit -->
      // Ensure we're on the schedule list page
      const scheduleVisible = await pageB.locator('.record-visititem:not(.placeholder)').count();
      if (scheduleVisible === 0) {
          console.log('ℹ Not on schedule list — going back to schedule page');
          await pageB.goBack();  // or navigate to schedule tab if there’s a direct link
          await pageB.waitForSelector('.record-visititem:not(.placeholder)', { timeout: 10000 });
      }

      // --- Open visit in Site B ---
      await waitForScheduleList(pageB);
      const expectedDateForSiteB = visit.visitDate?.trim() || visit.targetDate?.trim();

      const { timeIn, timeOut, documents } = await openVisitInSchedule(
        pageB,
        visit.siteBVisitName,
        expectedDateForSiteB,  // <-- use targetDate if visitDate is empty
        visit.therapist
      );

      // --- Switch to Site A and click Details ---
      await pageA.bringToFront();
      await clickDetailsInSiteA(
        pageA,
        normalizedTaskName,
        normalizedVisitDate,
        visit.therapist
      );

      // --- Check/fill times & dates ---
      const status = await checkVisitDateAndTimesFilled(pageA);
      if (!(status.dateFilled && status.timeInFilled && status.timeOutFilled)) {
        console.log('✏ Visit not filled — opening via View menu');
        await openVisitFromViewMenu(pageA, normalizedTaskName);
        const { visitDate, timeIn, timeOut } = await getVisitDateAndTimesFromSiteB(pageB);
        await pageA.bringToFront();
        await fillVisitDateAndTimesInSiteA(pageA, visitDate, timeIn, timeOut);
        await pageA.locator('input.Greeninputbutton[value="Approve"]').click();
        console.log('✅ Visit approved in Site A');
      } else {
        console.log('✓ Date and times already filled, skipping time entry');
      }

      // --- Standard visit PDF upload ---
      if (visit.siteBVisitName.toLowerCase() === 'standard') {
        const pdfFiles = await downloadVisitFiles(pageB, visit.siteBVisitName, normalizedVisitDate, patientName);
        if (pdfFiles.length) {
          await pageA.goBack();
          await pageA.waitForLoadState('networkidle');
          for (const file of pdfFiles) {
            await pageA.locator('input#attachment').setInputFiles(file);
            await pageA.locator('input#uploadAttachmentattachment').click();
            await pageA.waitForTimeout(1000);
          }
          await pageA.locator('input#taskdetailsubmit').click();
          console.log(`✅ Uploaded ${pdfFiles.length} PDF(s) and updated task`);
        } else {
          console.log('ℹ No PDFs found for this visit');
        }
      } else {
        console.log('ℹ Not a standard visit — skipping document upload');
      }

      // --- Return to Therapy tab for next visit ---
      await pageA.goBack();
      await openAllTherapyTab(pageA);
      console.log(`✓ Visit processed successfully: ${normalizedTaskName} on ${normalizedVisitDate}`);
    } catch (err: any) {
      console.log(`⚠ Visit failed: ${normalizedTaskName} on ${normalizedVisitDate} (${err.message})`);
    }
  }
  // --- After processing existing visits, check for missing ones ---

  await pageB.bringToFront();

  // Go to Patients list fresh (guaranteed correct state)
  await openPatientsList(pageB);

  try {
    await patientLink.click();
    await pageB.waitForLoadState('networkidle');
  } catch {
    console.log(`⚠ Could not reopen patient ${patientName} in Site B`);
    continue;
  }

  // Ensure schedule list is fully loaded
  await waitForScheduleList(pageB);

  // Fetch Site B visits
  const siteBVisitsForPatient = await getSiteBVisitsForPatient(pageB, patientName);

  // Build Site A visit key set
  const siteAVisitKeys = new Set(
    uniqueVisits.map(v =>
      `${v.taskName.trim()}-${v.visitDate.trim()}-${v.therapist?.trim()}`
    )
  );

  for (const bVisit of siteBVisitsForPatient) {

    // 🚫 Skip SOC visits
    if (isSOC(bVisit.taskName)) {
      console.log(`⏭ Skipping SOC visit: ${bVisit.taskName}`);
      continue;
    }

    const key = `${bVisit.taskName.trim()}-${bVisit.visitDate.trim()}-${bVisit.therapist?.trim()}`;

    if (siteAVisitKeys.has(key)) {
      continue; // already exists in Site A
    }

    // 🔎 Check schedule status in Site B
    const scheduleStatus = await resolveScheduleForVisit(pageB, bVisit);

    if (scheduleStatus !== 'SCHEDULED') {
      console.log(
        `⏭ Not adding ${bVisit.taskName} (${bVisit.visitDate}) — status: ${scheduleStatus}`
      );
      continue;
    }

    console.log(`➕ Adding SCHEDULED visit to Site A: ${bVisit.taskName} on ${bVisit.visitDate}`);

    await pageA.bringToFront();

    const added = await addMissingVisitInSiteA(
      pageA,
      bVisit.taskName,
      bVisit.visitDate,
      bVisit.therapist,
      bVisit.actualVisitType
    );
    if (!added) {
      console.log(`⚠ Skipped adding visit due to missing therapist`);
    }
    await pageB.bringToFront();
  }

  // --- Go back to Patients list in Site B ---
  await openPatientsList(pageB);
  await pageB.waitForLoadState('networkidle');
}

console.log('\n✔ All Site B patients processed');


}

// --- Helper: Convert Site B AM/PM time to 24h format ---
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

main()