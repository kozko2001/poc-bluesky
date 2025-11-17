import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Validates if a string is a valid Bluesky post URL
 * Format: https://bsky.app/profile/{did or handle}/post/{postId}
 */
export function isValidBlueskyUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);

    // Check if it's HTTPS
    if (urlObj.protocol !== 'https:') {
      return false;
    }

    // Check if it's a bsky.app domain
    if (urlObj.hostname !== 'bsky.app') {
      return false;
    }

    // Check if path matches the pattern /profile/{...}/post/{...}
    const pathPattern = /^\/profile\/[^\/]+\/post\/[^\/]+\/?$/;
    return pathPattern.test(urlObj.pathname);
  } catch {
    return false;
  }
}

/**
 * Extracts the post ID from a Bluesky URL
 */
export function extractPostId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const parts = urlObj.pathname.split('/');
    const postIndex = parts.indexOf('post');

    if (postIndex !== -1 && parts[postIndex + 1]) {
      return parts[postIndex + 1];
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Reads URLs from a text file (one URL per line)
 * Ignores empty lines and lines starting with #
 */
export async function readUrlsFromFile(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    return lines
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  } catch (error) {
    throw new Error(`Failed to read URLs from file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Ensures a directory exists, creates it if it doesn't
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

/**
 * Generates a sequential filename for a screenshot
 */
export function generateFilename(index: number, format: 'png' | 'jpg' = 'png'): string {
  const paddedIndex = String(index + 1).padStart(3, '0');
  return `post-${paddedIndex}.${format}`;
}

/**
 * Gets the absolute path, handling both relative and absolute paths
 */
export function getAbsolutePath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}
