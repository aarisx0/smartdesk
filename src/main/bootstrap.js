'use strict';
/**
 * bootstrap.js — Real Electron entry point.
 *
 * Loads .env FIRST (before any import/require in index.js can pull in
 * supabase.js or any other module that reads process.env at require-time),
 * then hands off to the compiled main process.
 */

// Step 1: populate process.env from .env file
require('./env-loader');

// Step 2: start the actual application
require('./index');
