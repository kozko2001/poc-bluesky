#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import { isValidBlueskyUrl, readUrlsFromFile, getAbsolutePath, generateFilename } from './utils.js';
import { processBatch, processSingle } from './batch.js';

const program = new Command();

program
  .name('bsky-screenshot')
  .description('CLI tool to screenshot Bluesky posts')
  .version('1.0.0');

program
  .argument('[urls...]', 'Bluesky post URL(s) to screenshot')
  .option('-f, --file <path>', 'Read URLs from a file (one per line)')
  .option('-o, --output <path>', 'Output directory or file path', './screenshots')
  .option('--timeout <ms>', 'Page load timeout in milliseconds', '30000')
  .option('--no-transparent', 'Disable transparent background')
  .option('--headed', 'Run browser in headed mode (visible, for debugging)')
  .action(async (urlArgs: string[], options) => {
    try {
      let urls: string[] = [];

      // Collect URLs from arguments
      if (urlArgs && urlArgs.length > 0) {
        urls.push(...urlArgs);
      }

      // Collect URLs from file if specified
      if (options.file) {
        const fileUrls = await readUrlsFromFile(options.file);
        urls.push(...fileUrls);
      }

      // Remove duplicates
      urls = [...new Set(urls)];

      // Validate we have at least one URL
      if (urls.length === 0) {
        console.error('Error: No URLs provided. Use --file or provide URLs as arguments.');
        console.error('Example: bsky-screenshot <url> or bsky-screenshot -f urls.txt');
        process.exit(1);
      }

      // Validate all URLs
      const invalidUrls = urls.filter(url => !isValidBlueskyUrl(url));
      if (invalidUrls.length > 0) {
        console.error('Error: Invalid Bluesky URL(s):');
        invalidUrls.forEach(url => console.error(`  - ${url}`));
        console.error('\nExpected format: https://bsky.app/profile/{handle}/post/{postId}');
        process.exit(1);
      }

      // Parse options
      const timeout = parseInt(options.timeout, 10);
      const omitBackground = options.transparent !== false;
      const headless = !options.headed; // Invert: --headed flag means headless=false

      const screenshotOptions = {
        timeout,
        omitBackground,
        headless
      };

      // Determine if this is a single URL or batch processing
      if (urls.length === 1 && !options.output.endsWith(path.sep) && !options.file) {
        // Single URL with specific output path
        const outputPath = getAbsolutePath(options.output);

        // If output doesn't have an extension, treat it as a directory
        const ext = path.extname(outputPath);
        const finalOutputPath = ext ? outputPath : path.join(outputPath, generateFilename(0));

        await processSingle(urls[0], finalOutputPath, screenshotOptions);
      } else {
        // Batch processing
        const outputDir = getAbsolutePath(options.output);

        const result = await processBatch(urls, outputDir, screenshotOptions);

        console.log('\n' + '='.repeat(50));
        console.log(`Summary:`);
        console.log(`  Total: ${urls.length}`);
        console.log(`  Successful: ${result.successful}`);
        console.log(`  Failed: ${result.failed}`);
        console.log(`  Output directory: ${result.outputDir}`);
        console.log(`  Manifest: ${result.manifestPath}`);
        console.log('='.repeat(50));

        if (result.failed > 0) {
          process.exit(1);
        }
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
  });

program.parse(process.argv);
