import { Browser } from 'playwright';
import { runSiteB } from './siteB';

export async function runSiteA(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();

  // --- Load credentials from environment variables ---
  const user = process.env.SITE_A_USER!;
  const pass = process.env.SITE_A_PASS!;
  const url  = process.env.SITE_A_URL!;

  console.log('Opening SiteA login page...');
  await page.goto(url);

  // --- Handle JavaScript alert automatically ---
  page.on('dialog', async dialog => {
    console.log('Alert detected:', dialog.message());
    await dialog.accept();
    console.log('Alert accepted');
  });

  // --- Wait for username input and fill ---
  const usernameInput = page.locator('input[name="username"]');
  await usernameInput.waitFor({ state: 'visible', timeout: 10000 });
  await usernameInput.fill(user);
  console.log('Username filled');

  // --- Wait for password input and fill ---
  const passwordInput = page.locator('input[name="password"]');
  await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
  await passwordInput.fill(pass);
  console.log('Password filled');

  // --- Wait for login button and click ---
  const loginButton = page.locator('#login_btn');
  await loginButton.waitFor({ state: 'visible', timeout: 10000 });
  await loginButton.click();
  console.log('Login button clicked');

  // --- Wait for page to load fully after login ---
  await page.waitForLoadState('networkidle');
  console.log('SiteA login successful');

  return page;

  // Close context (browser stays open if needed in main)
  // await context.close();
}


