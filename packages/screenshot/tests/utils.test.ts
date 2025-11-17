import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  isValidBlueskyUrl,
  extractPostId,
  readUrlsFromFile,
  ensureDirectory,
  generateFilename,
  getAbsolutePath
} from '../src/utils.js';

describe('isValidBlueskyUrl', () => {
  it('should validate correct Bluesky URLs', () => {
    const validUrls = [
      'https://bsky.app/profile/did:plc:rrfwruhud4ovela3oe6isre5/post/3m3iwjohoxc2e',
      'https://bsky.app/profile/handle.bsky.social/post/abc123',
      'https://bsky.app/profile/user.name/post/123456789'
    ];

    validUrls.forEach(url => {
      expect(isValidBlueskyUrl(url)).toBe(true);
    });
  });

  it('should reject invalid URLs', () => {
    const invalidUrls = [
      'https://twitter.com/user/status/123',
      'https://bsky.app/profile/user',
      'https://bsky.app/post/123',
      'not-a-url',
      'https://bsky.app/profile//post/',
      'http://bsky.app/profile/user/post/123' // http instead of https
    ];

    invalidUrls.forEach(url => {
      expect(isValidBlueskyUrl(url)).toBe(false);
    });
  });
});

describe('extractPostId', () => {
  it('should extract post ID from valid URL', () => {
    const url = 'https://bsky.app/profile/did:plc:rrfwruhud4ovela3oe6isre5/post/3m3iwjohoxc2e';
    expect(extractPostId(url)).toBe('3m3iwjohoxc2e');
  });

  it('should return null for invalid URL', () => {
    expect(extractPostId('not-a-url')).toBe(null);
    expect(extractPostId('https://bsky.app/profile/user')).toBe(null);
  });
});

describe('readUrlsFromFile', () => {
  const testDir = path.join(__dirname, 'temp-test-files');
  const testFile = path.join(testDir, 'urls.txt');

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should read URLs from file', async () => {
    const content = `https://bsky.app/profile/user1/post/123
https://bsky.app/profile/user2/post/456
https://bsky.app/profile/user3/post/789`;

    await fs.writeFile(testFile, content);

    const urls = await readUrlsFromFile(testFile);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe('https://bsky.app/profile/user1/post/123');
  });

  it('should ignore empty lines and comments', async () => {
    const content = `https://bsky.app/profile/user1/post/123

# This is a comment
https://bsky.app/profile/user2/post/456

# Another comment`;

    await fs.writeFile(testFile, content);

    const urls = await readUrlsFromFile(testFile);
    expect(urls).toHaveLength(2);
  });

  it('should throw error for non-existent file', async () => {
    await expect(readUrlsFromFile('/non/existent/file.txt')).rejects.toThrow();
  });
});

describe('ensureDirectory', () => {
  const testDir = path.join(__dirname, 'temp-test-dir');

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should create directory if it does not exist', async () => {
    await ensureDirectory(testDir);
    const stats = await fs.stat(testDir);
    expect(stats.isDirectory()).toBe(true);
  });

  it('should not throw if directory already exists', async () => {
    await fs.mkdir(testDir);
    await expect(ensureDirectory(testDir)).resolves.not.toThrow();
  });
});

describe('generateFilename', () => {
  it('should generate sequential filenames', () => {
    expect(generateFilename(0)).toBe('post-001.png');
    expect(generateFilename(5)).toBe('post-006.png');
    expect(generateFilename(99)).toBe('post-100.png');
  });

  it('should support different formats', () => {
    expect(generateFilename(0, 'jpg')).toBe('post-001.jpg');
    expect(generateFilename(10, 'png')).toBe('post-011.png');
  });
});

describe('getAbsolutePath', () => {
  it('should return absolute path as-is', () => {
    const absPath = '/absolute/path/to/file';
    expect(getAbsolutePath(absPath)).toBe(absPath);
  });

  it('should resolve relative path', () => {
    const relPath = './relative/path';
    const result = getAbsolutePath(relPath);
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain('relative/path');
  });
});
