import { Browser } from 'playwright';

export async function runSiteB(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();

  const user = process.env.SITE_B_USER!;
  const pass = process.env.SITE_B_PASS!;
  const url  = process.env.SITE_B_URL!;

  await page.goto(url);

   // --- Wait for username input and fill ---
  const usernameInput = page.locator('input[name="UserName"]');
  await usernameInput.waitFor({ state: 'visible', timeout: 10000 });
  await usernameInput.fill(user);
  console.log('Username filled');

  // --- Wait for password input and fill ---
  const passwordInput = page.locator('input[name="Password"]');
  await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
  await passwordInput.fill(pass);
  console.log('Password filled');

  // --- Wait for login button and click ---
  const loginButton = page.locator('#loginButton');
  await loginButton.waitFor({ state: 'visible', timeout: 10000 });
  await loginButton.click();
  console.log('Login button clicked');

  // --- Wait for page to load fully after login ---
  await page.waitForLoadState('networkidle');
  console.log('SiteB login successful');

  return page;

  // await context.close();
}
