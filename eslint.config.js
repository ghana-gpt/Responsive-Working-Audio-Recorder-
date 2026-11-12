// Flat ESLint config (ESLint 9/10).
//
// The browser and Node halves of the repo need different globals, so they are
// configured separately. `globals` is not a dependency: the (small) set of
// globals this project actually uses is declared explicitly.

import js from '@eslint/js';

const sharedRules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-console': 'off',
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
  'object-shorthand': 'error',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  console: 'readonly',
  self: 'readonly',
  clients: 'readonly',
  caches: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  getComputedStyle: 'readonly',
  localStorage: 'readonly',
  isSecureContext: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FormData: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  DOMException: 'readonly',
  DecompressionStream: 'readonly',
  CompressionStream: 'readonly',
  ReadableStream: 'readonly',
  WritableStream: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  crypto: 'readonly',
  performance: 'readonly',
  indexedDB: 'readonly',
  IDBKeyRange: 'readonly',
  MediaRecorder: 'readonly',
  MediaStream: 'readonly',
  AudioContext: 'readonly',
  CSS: 'readonly',
  Element: 'readonly',
  Node: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  HTMLElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLSelectElement: 'readonly',
  HTMLFormElement: 'readonly',
  HTMLDetailsElement: 'readonly',
  HTMLAudioElement: 'readonly',
};

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  performance: 'readonly',
  structuredClone: 'readonly',
  DOMException: 'readonly',
  DecompressionStream: 'readonly',
  CompressionStream: 'readonly',
};

export default [
  { ignores: ['node_modules/**', 'icons/**', 'image/**', 'coverage/**'] },
  {
    files: ['scripts/**/*.js', 'service-worker.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: browserGlobals,
    },
    rules: sharedRules,
  },
  {
    files: ['tools/**/*.mjs', 'tests/unit/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: sharedRules,
  },
  {
    // The e2e suite runs in Node but its `page.evaluate` callbacks run in the
    // browser, so both sets of globals are legitimately in scope.
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...nodeGlobals, ...browserGlobals },
    },
    rules: sharedRules,
  },
  {
    // Control characters are stripped from user text on purpose here.
    files: ['scripts/modules/sanitize.js'],
    rules: { 'no-control-regex': 'off' },
  },
];
