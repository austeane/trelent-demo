/**
 * Vitest setup file
 * This runs before all tests
 */

import { vi, beforeAll, afterAll, afterEach } from 'vitest';

// Reset all mocks after each test
afterEach(() => {
  vi.clearAllMocks();
});

// Clean up after all tests
afterAll(() => {
  vi.restoreAllMocks();
});

// Suppress console output during tests (optional)
beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  // Keep error and warn for debugging
});
