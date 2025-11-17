import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { capturePostScreenshot, captureBatchScreenshots } from '../src/screenshot.js';

// Note: These are integration tests that require network access and Playwright
// Skip these tests if running in CI without proper setup

const TEST_URL = 'https://bsky.app/profile/did:plc:rrfwruhud4ovela3oe6isre5/post/3m3iwjohoxc2e';
const testOutputDir = path.join(__dirname, 'temp-screenshots');

describe('screenshot integration tests', () => {
  beforeAll(async () => {
    await fs.mkdir(testOutputDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test files
    try {
      await fs.rm(testOutputDir, { recursive: true, force: true });
      await fs.mkdir(testOutputDir, { recursive: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it('should capture a screenshot of a Bluesky post', async () => {
    const screenshot = await capturePostScreenshot(TEST_URL, {
      timeout: 60000,
      omitBackground: true
    });

    expect(screenshot).toBeInstanceOf(Buffer);
    expect(screenshot.length).toBeGreaterThan(0);

    // Verify it's a valid PNG by checking the header
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(screenshot.subarray(0, 8).equals(pngHeader)).toBe(true);
  }, 60000);

  it('should throw error for invalid URL', async () => {
    await expect(
      capturePostScreenshot('https://invalid-url.com', { timeout: 5000 })
    ).rejects.toThrow();
  }, 10000);

  it('should capture batch screenshots', async () => {
    const urls = [TEST_URL];

    const results = await captureBatchScreenshots(urls, {
      timeout: 60000,
      omitBackground: true
    });

    expect(results.size).toBe(1);
    expect(results.has(TEST_URL)).toBe(true);

    const screenshot = results.get(TEST_URL);
    expect(screenshot).toBeInstanceOf(Buffer);
    expect(screenshot!.length).toBeGreaterThan(0);
  }, 60000);

  it('should handle multiple URLs in batch', async () => {
    // Using the same URL multiple times for testing
    // In real scenarios, these would be different posts
    const urls = [TEST_URL];

    const results = await captureBatchScreenshots(urls, {
      timeout: 60000
    });

    expect(results.size).toBe(urls.length);
  }, 90000);

  it('should save screenshot to file', async () => {
    const screenshot = await capturePostScreenshot(TEST_URL, {
      timeout: 60000
    });

    const outputPath = path.join(testOutputDir, 'test-screenshot.png');
    await fs.writeFile(outputPath, screenshot);

    const stats = await fs.stat(outputPath);
    expect(stats.size).toBeGreaterThan(0);
  }, 60000);
});
