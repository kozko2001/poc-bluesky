import * as fs from 'fs/promises';
import * as path from 'path';
import { captureBatchScreenshots, ScreenshotOptions } from './screenshot.js';
import { ensureDirectory, generateFilename } from './utils.js';

export interface ManifestEntry {
  url: string;
  filename: string;
  timestamp: string;
  success: boolean;
  error?: string;
}

export interface BatchResult {
  outputDir: string;
  manifestPath: string;
  successful: number;
  failed: number;
  entries: ManifestEntry[];
}

/**
 * Process multiple URLs and save screenshots with manifest
 */
export async function processBatch(
  urls: string[],
  outputDir: string,
  options: ScreenshotOptions = {}
): Promise<BatchResult> {
  // Ensure output directory exists
  await ensureDirectory(outputDir);

  const entries: ManifestEntry[] = [];
  let successful = 0;
  let failed = 0;

  console.log(`\nProcessing ${urls.length} URL(s)...`);

  try {
    // Capture all screenshots
    const screenshots = await captureBatchScreenshots(urls, options);

    // Save screenshots and create manifest entries
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const filename = generateFilename(i);
      const filePath = path.join(outputDir, filename);

      const screenshot = screenshots.get(url);

      if (screenshot) {
        try {
          await fs.writeFile(filePath, screenshot);
          console.log(`✓ Saved: ${filename} (${url})`);

          entries.push({
            url,
            filename,
            timestamp: new Date().toISOString(),
            success: true
          });
          successful++;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Failed to save file';
          console.error(`✗ Failed to save ${filename}: ${errorMsg}`);

          entries.push({
            url,
            filename,
            timestamp: new Date().toISOString(),
            success: false,
            error: errorMsg
          });
          failed++;
        }
      } else {
        const errorMsg = 'Screenshot capture failed';
        console.error(`✗ Failed: ${url}`);

        entries.push({
          url,
          filename,
          timestamp: new Date().toISOString(),
          success: false,
          error: errorMsg
        });
        failed++;
      }
    }

    // Create manifest
    const manifestPath = path.join(outputDir, 'manifest.json');
    const manifest = {
      generated: new Date().toISOString(),
      total: urls.length,
      successful,
      failed,
      entries
    };

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`\nManifest saved: ${manifestPath}`);

    return {
      outputDir,
      manifestPath,
      successful,
      failed,
      entries
    };
  } catch (error) {
    throw new Error(`Batch processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Process a single URL and save screenshot
 */
export async function processSingle(
  url: string,
  outputPath: string,
  options: ScreenshotOptions = {}
): Promise<void> {
  const { captureBatchScreenshots } = await import('./screenshot.js');

  console.log(`\nProcessing: ${url}`);

  const screenshots = await captureBatchScreenshots([url], options);
  const screenshot = screenshots.get(url);

  if (!screenshot) {
    throw new Error('Failed to capture screenshot');
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  await ensureDirectory(outputDir);

  await fs.writeFile(outputPath, screenshot);
  console.log(`✓ Screenshot saved: ${outputPath}`);
}
