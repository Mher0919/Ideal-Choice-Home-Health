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
  isSOC,
  isDischarge,
  isDeleted,
  dismissOverlay,
} from './siteA.actions';

import {
  downloadVisitFiles,
  getSiteBVisitsForPatient,
  getVisitDateAndTimesFromSiteB,
  openPatientsList,
  openVisitInSchedule,
  resolveScheduleForVisit,
  waitForScheduleList,
  normalizeVisitKey,
} from './siteB.actions';

import path from 'path';
import { startRun, logChange, flushLog } from './logger';

// Filename sanitizer (same rules as siteB.actions — Kinser allowed chars)
const safe = (s: string) => s
  .replace(/,/g, '')
  .replace(/[^A-Za-z0-9 \-_(). ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

function normalizeText(str: string): string {
  return str
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x00-\x7F]/g, '')
    .trim()
    .toLowerCase();
}

async function main() {
  startRun();
  const browser = await chromium.launch({ headless: false });
  const pageA = await runSiteA(browser);
  const pageB = await runSiteB(browser);

  await openPatientManager(pageA);
  await openPatientsList(pageB);

  const patientNames: string[] = [];
  const patientRows = pageB.locator('#PatientsTable tbody tr');
  const patientCount = await patientRows.count();
  for (let i = 0; i < patientCount; i++) {
    const name = (
      await patientRows.nth(i).locator('td.sorting_1 a.link-Color').innerText()
    ).trim();
    patientNames.push(name);
  }
  console.log(`Total patients in Site B: ${patientNames.length}`);

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
    const therapyTable = pageA.locator('table#scheduled-task');
    try {
      await therapyTable.waitFor({ state: 'visible', timeout: 10000 });
    } catch {
      console.log(`⚠ No visits found for patient "${patientName}", skipping.`);
      continue;
    }

    // --- Get all incomplete visits (single-pass, discharge/SOC already filtered) ---
    const visits = await getAllIncompleteVisits(pageA);
    if (visits.length === 0) {
      console.log(`✓ No actionable visits for patient "${patientName}"`);
      await pageB.bringToFront();
      continue;
    }

    // --- Deduplicate by normalized taskName + date (therapist strings are unreliable for matching) ---
    const uniqueVisits = Array.from(
      new Map(
        visits.map((v) => [normalizeVisitKey(v.taskName, v.visitDate || v.targetDate), v])
      ).values()
    );
    console.log(
      `Found ${uniqueVisits.length} unique incomplete visit(s) for patient "${patientName}"`
    );

    // --- Open patient page in Site B ---
    await pageB.bringToFront();
    const patientLink = pageB.locator(
      `#PatientsTable tbody tr td.sorting_1 a.link-Color`,
      { hasText: patientName }
    );
    try {
      await patientLink.click();
      await pageB.waitForLoadState('networkidle');
      console.log(`Opened patient page in Site B: ${patientName}`);
    } catch {
      console.log(
        `⚠ Could not open patient page in Site B: ${patientName}, skipping visits.`
      );
      continue;
    }

    // Only process visits that have a date and name
    const actionableVisits = uniqueVisits.filter(
      (v) => v.needsAction && v.taskName?.trim() && v.visitDate?.trim()
    );

    for (const visit of actionableVisits) {
      const normalizedTaskName = visit.taskName.replace(/\s+/g, ' ').trim();
      const normalizedVisitDate = visit.visitDate.trim();

      console.log(
        `➡ Processing visit: ${normalizedTaskName} on ${normalizedVisitDate} with ${visit.therapist || 'Unknown therapist'}`
      );

      try {
        // Ensure we're on the schedule list page
        const scheduleVisible = await pageB
          .locator('.record-visititem:not(.placeholder)')
          .count();
        if (scheduleVisible === 0) {
          console.log('ℹ Not on schedule list — going back to schedule page');
          await pageB.goBack();
          await pageB.waitForSelector('.record-visititem:not(.placeholder)', {
            timeout: 10000,
          });
        }

        await waitForScheduleList(pageB);

        // Use targetDate as fallback when visitDate is empty
        const expectedDateForSiteB =
          visit.visitDate?.trim() || visit.targetDate?.trim();

        // --- Open visit in Site B (pass Site A task name — mapping handled inside) ---
        const { timeIn, timeOut, siteBStatus } = await openVisitInSchedule(
          pageB,
          normalizedTaskName,
          expectedDateForSiteB,
          visit.therapist
        );

        // Missed visits: download PDFs only, never upload to Site A
        const isMissedVisit = /missed/i.test(siteBStatus);

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
          console.log('✏ Visit not filled — filling from Site B times');
          await openVisitFromViewMenu(pageA, normalizedTaskName);

          // Re-fetch times from the Site B detail page that's still open
          await pageB.bringToFront();
          const { visitDate: detailDate, timeIn: tIn, timeOut: tOut } =
            await getVisitDateAndTimesFromSiteB(pageB);

          await pageA.bringToFront();
          await fillVisitDateAndTimesInSiteA(pageA, detailDate, tIn, tOut);
          await pageA.locator('input.Greeninputbutton[value="Approve"]').click();
          await pageA.waitForLoadState('networkidle');
          console.log('✅ Visit approved in Site A');
          logChange(patientName, `Filled time in/out for "${normalizedTaskName}" on ${normalizedVisitDate} — In: ${tIn}, Out: ${tOut} — Approved`);
        } else {
          console.log('✓ Date and times already filled, skipping time entry');
        }

        // --- Download PDFs from Site B (all visit types) ---
        await pageB.bringToFront();
        const pdfFiles = await downloadVisitFiles(
          pageB,
          normalizedTaskName,   // e.g. "PTA Visit" — used in filename
          normalizedVisitDate,
          patientName
        );

        // --- Upload PDFs to Site A only for standard visits that are NOT missed ---
        const isStandardVisit = /standard|pta visit|cota visit|ot visit|pt visit|st visit/i
          .test(normalizedTaskName);

        // Helper to sanitize strings for fuzzy filename matching
        const safeName = (s: string) => s.replace(/,/g, '').replace(/[^A-Za-z0-9 \-_(). ]/g, '').replace(/\s+/g, '-').toLowerCase().trim();
        const attachFuzzyKey = `${safeName(normalizedTaskName)}-${normalizedVisitDate.replace(/\//g, '-')}`;

        if (isMissedVisit) {
          if (pdfFiles.length > 0) {
            logChange(patientName, `Downloaded ${pdfFiles.length} PDF(s) for "${normalizedTaskName}" on ${normalizedVisitDate} (not uploaded — missed visit): ${pdfFiles.map(f => path.basename(f)).join(', ')}`);
          }
          console.log(`  ℹ Missed visit — PDFs downloaded only, not uploaded to Site A`);
        } else if (isStandardVisit && pdfFiles.length > 0) {
          await pageA.bringToFront();

          // Check what's already attached in Kinser (fuzzy match on date + visit type)
          const existingAttachments = await pageA
            .locator('#AttachmentTableattachment a, #AttachmentTableattachment span')
            .allInnerTexts()
            .catch(() => [] as string[]);

          const alreadyUploaded = existingAttachments.some(name =>
            safeName(name).includes(attachFuzzyKey)
          );

          if (alreadyUploaded) {
            console.log(`  ⏭ Already uploaded to Kinser — skipping upload for "${normalizedTaskName}" on ${normalizedVisitDate}`);
          } else {
            for (const file of pdfFiles) {
              await dismissOverlay(pageA);
              await pageA.locator('input#attachment').setInputFiles(file);
              await pageA.waitForFunction(
                () => {
                  const el = document.querySelector('input#attachment') as HTMLInputElement;
                  return el && el.files && el.files.length > 0;
                },
                { timeout: 5000 }
              );
              await dismissOverlay(pageA);
              pageA.once('dialog', async dialog => {
                console.log(`  ⚠ Upload dialog: "${dialog.message()}" — accepting`);
                await dialog.accept();
              });
              await pageA.locator('input#uploadAttachmentattachment').click();
              await pageA.waitForTimeout(1500);
              console.log(`  ✅ Uploaded: ${path.basename(file)}`);
            }

            await dismissOverlay(pageA);
            await pageA.locator('input#taskdetailsubmit').click();
            await pageA.waitForLoadState('networkidle');
            console.log(`✅ Uploaded ${pdfFiles.length} PDF(s) and updated task in Site A`);
            logChange(patientName, `Downloaded + uploaded ${pdfFiles.length} PDF(s) for "${normalizedTaskName}" on ${normalizedVisitDate}: ${pdfFiles.map(f => path.basename(f)).join(', ')}`);

            // After taskdetailsubmit need extra goBack to reach therapy tab
            await pageA.goBack();
          }
          await pageA.waitForLoadState('networkidle');
        } else if (isStandardVisit && pdfFiles.length === 0) {
          console.log('  ℹ No PDFs to upload for this standard visit');
        } else {
          if (pdfFiles.length > 0) {
            logChange(patientName, `Downloaded ${pdfFiles.length} PDF(s) for "${normalizedTaskName}" on ${normalizedVisitDate} (not uploaded — non-standard visit): ${pdfFiles.map(f => path.basename(f)).join(', ')}`);
          }
          console.log('  ℹ Non-standard visit — PDFs downloaded only, not uploaded to Site A');
        }

        // --- Return to Site B schedule list for next visit ---
        await pageB.bringToFront();
        await pageB.goBack();
        await pageB.waitForLoadState('networkidle');

        // --- Go back one page in Site A (returns to All Therapy tab) ---
        await pageA.bringToFront();
        await pageA.goBack();
        await pageA.waitForLoadState('networkidle');

        console.log(
          `✓ Visit processed successfully: ${normalizedTaskName} on ${normalizedVisitDate}`
        );
      } catch (err: any) {
        // "No scheduled time" is expected — log quietly
        if (err.message?.startsWith('SKIP:no_scheduled_time')) {
          console.log(`  ℹ Skipping "${normalizedTaskName}" on ${normalizedVisitDate} — no scheduled time in Site B yet`);
        } else {
          console.log(`⚠ Visit failed: ${normalizedTaskName} on ${normalizedVisitDate} (${err.message})`);
        }

        // ── Recovery: get both sites back to a known good state ──────────────

        // Site B → back to schedule list
        try {
          await pageB.bringToFront();
          await dismissOverlay(pageB);
          const onList = await pageB.locator('.record-visititem:not(.placeholder)').count();
          if (onList === 0) {
            await pageB.goBack();
            await pageB.waitForLoadState('networkidle');
          }
        } catch { /* best effort */ }

        // Site A → dismiss overlay, then navigate back to therapy tab
        try {
          await pageA.bringToFront();
          await dismissOverlay(pageA);
          // Try to go back until we can see the LinkTherapy tab (max 3 backs)
          for (let b = 0; b < 3; b++) {
            const hasTherapyTab = await pageA.locator('a#LinkTherapy').count();
            if (hasTherapyTab > 0) break;
            await pageA.goBack();
            await pageA.waitForLoadState('networkidle');
          }
        } catch { /* best effort */ }
      }
    }

    // ── After processing existing visits, check for missing ones in Site A ──

    await pageB.bringToFront();
    await openPatientsList(pageB);

    try {
      await patientLink.click();
      await pageB.waitForLoadState('networkidle');
    } catch {
      console.log(`⚠ Could not reopen patient ${patientName} in Site B`);
      continue;
    }

    try {
      await waitForScheduleList(pageB);
    } catch {
      console.log(`⚠ Could not load schedule list for ${patientName} — skipping missing-visit check`);
      continue;
    }

    // Fetch Site B visits (SOC + Discharge already skipped inside)
    const siteBVisitsForPatient = await getSiteBVisitsForPatient(pageB, patientName);

    // Build Site A visit key set for dedup — keyed by normalizedTaskName + ISO date only
    // (therapist strings differ too much between sites to be reliable)
    const siteAVisitKeys = new Set(
      uniqueVisits.map((v) =>
        normalizeVisitKey(v.taskName, v.visitDate || v.targetDate)
      )
    );

    for (const bVisit of siteBVisitsForPatient) {

      // Extra safety guards
      if (isSOC(bVisit.taskName) || isDischarge(bVisit.taskName)) {
        console.log(`⏭ Skipping SOC/Discharge visit: ${bVisit.taskName}`);
        continue;
      }

      // Check if this visit already exists in Site A by taskName + date
      const key = normalizeVisitKey(bVisit.taskName, bVisit.visitDate);
      if (siteAVisitKeys.has(key)) {
        console.log(`  ✓ Already in Site A: ${bVisit.taskName} (${bVisit.visitDate}) — skipping`);
        continue;
      }

      // resolveScheduleForVisit uses the raw Site B visititem-type (siteBVisitName)
      // for DOM matching, NOT the derived Site A task name
      const scheduleStatus = await resolveScheduleForVisit(pageB, {
        taskName:  bVisit.siteBVisitName,   // raw Site B type e.g. "STANDARD"
        visitDate: bVisit.visitDate,
      });

      if (scheduleStatus !== 'SCHEDULED') {
        console.log(
          `⏭ Not adding ${bVisit.taskName} (${bVisit.visitDate}) — status: ${scheduleStatus}`
        );
        continue;
      }

      console.log(
        `➕ Adding SCHEDULED visit to Site A: ${bVisit.taskName} on ${bVisit.visitDate}`
      );

      await pageA.bringToFront();

      const added = await addMissingVisitInSiteA(
        pageA,
        bVisit.taskName,
        bVisit.visitDate,
        bVisit.therapist,
        bVisit.actualVisitType
      );
      if (!added) {
        console.log(`⚠ Skipped adding visit due to missing therapist or error`);
      } else {
        logChange(patientName, `Added new visit to Kinser: "${bVisit.taskName}" on ${bVisit.visitDate} (therapist: ${bVisit.therapist})`);
      }

      await pageB.bringToFront();
    }

    // --- Go back to Patients list in Site B ---
    await openPatientsList(pageB);
    await pageB.waitForLoadState('networkidle');
  }

  console.log('\n✔ All Site B patients processed');
  flushLog();
}

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  flushLog();
  process.exit(1);
});