import { chromium, Browser, Page } from 'playwright';

export interface ScreenshotOptions {
  /**
   * Timeout in milliseconds for page load (default: 30000)
   */
  timeout?: number;

  /**
   * Whether to use transparent background (default: true)
   */
  omitBackground?: boolean;

  /**
   * Whether to run browser in headless mode (default: true)
   * Set to false to see the browser window for debugging
   */
  headless?: boolean;
}

/**
 * Takes a screenshot of a Bluesky post
 * @param url - The Bluesky post URL
 * @param options - Screenshot options
 * @returns Buffer containing the PNG image data
 */
export async function capturePostScreenshot(
  url: string,
  options: ScreenshotOptions = {}
): Promise<Buffer> {
  const {
    timeout = 30000,
    omitBackground = true,
    headless = true
  } = options;

  let browser: Browser | null = null;

  try {
    // Launch browser (headless or headed for debugging)
    // Use executablePath from environment if available (for Nix environments)
    const launchOptions: any = {
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    };

    // Use custom Chromium path if provided via environment variable
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
      console.log(`[DEBUG] Using Chromium from: ${launchOptions.executablePath}`);
    } else {
      console.log('[DEBUG] Using Playwright bundled Chromium');
    }

    console.log(`[DEBUG] Running in ${headless ? 'headless' : 'headed'} mode`);
    console.log('[DEBUG] Launch options:', JSON.stringify(launchOptions, null, 2));
    browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2 // For higher quality screenshots
    });

    const page = await context.newPage();

    // Navigate to the URL
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout
    });

    // Wait for the post content to be visible
    // Bluesky posts use data-testid that starts with "postThreadItem-by-"
    // Using ^= to match elements that start with this prefix
    await page.waitForSelector('[data-testid^="postThreadItem"]', {
      timeout,
      state: 'visible'
    });

    // Additional wait to ensure images/embeds are loaded
    await page.waitForTimeout(2000);

    // Find the main post element
    const postElement = page.locator('[data-testid^="postThreadItem"]').first();

    // Take screenshot of the post element
    const screenshot = await postElement.screenshot({
      type: 'png',
      omitBackground
    });

    await browser.close();

    return screenshot;
  } catch (error) {
    if (browser) {
      await browser.close();
    }

    throw new Error(
      `Failed to capture screenshot: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Batch screenshot capture with browser reuse for better performance
 */
export async function captureBatchScreenshots(
  urls: string[],
  options: ScreenshotOptions = {}
): Promise<Map<string, Buffer>> {
  const results = new Map<string, Buffer>();
  let browser: Browser | null = null;

  try {
    // Launch browser with custom executable path if provided
    const { headless = true } = options;

    const launchOptions: any = {
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    };

    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }

    browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2
    });

    for (const url of urls) {
      try {
        const page = await context.newPage();
        const screenshot = await capturePageScreenshot(page, url, options);
        results.set(url, screenshot);
        await page.close();
      } catch (error) {
        console.error(`Failed to screenshot ${url}:`, error);
        // Continue with other URLs even if one fails
      }
    }

    await browser.close();
  } catch (error) {
    if (browser) {
      await browser.close();
    }
    throw new Error(`Batch screenshot failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return results;
}

/**
 * Helper function to capture screenshot from an existing page
 */
async function capturePageScreenshot(
  page: Page,
  url: string,
  options: ScreenshotOptions
): Promise<Buffer> {
  const { timeout = 30000, omitBackground = true } = options;

  await page.goto(url, {
    waitUntil: 'networkidle',
    timeout
  });

  await page.waitForSelector('[data-testid^="postThreadItem"]', {
    timeout,
    state: 'visible'
  });

  await page.waitForTimeout(2000);

  const postElement = page.locator('[data-testid^="postThreadItem"]').first();
  return await postElement.screenshot({
    type: 'png',
    omitBackground
  });
}
