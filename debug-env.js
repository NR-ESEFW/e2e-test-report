#!/usr/bin/env node

/**
 * Debug script to check environment in GitHub Actions
 */

import dotenv from 'dotenv';
dotenv.config();

console.log('=== ENVIRONMENT DEBUG ===');
console.log('Node.js version:', process.version);
console.log('Platform:', process.platform);
console.log('');

console.log('=== ENVIRONMENT VARIABLES CHECK ===');
const requiredVars = [
  'GOOGLE_SHEETS_SPREADSHEET_ID',
  'GOOGLE_SHEETS_GID',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'XRAY_CLIENT_ID',
  'XRAY_CLIENT_SECRET',
  'JIRA_CLIENT_SECRET',
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'ENABLE_BUG_REPORTS',
  'ENABLE_PRORATION_CALC'
];

requiredVars.forEach(varName => {
  const value = process.env[varName];
  console.log(`${varName}: ${value ? '✅ SET' : '❌ MISSING'} (${value ? value.substring(0, 10) + '...' : 'undefined'})`);
});

console.log('');
console.log('=== FILE SYSTEM CHECK ===');
import fs from 'fs';
import path from 'path';

const files = ['google-token.json', 'package.json', '.env'];
files.forEach(file => {
  const exists = fs.existsSync(file);
  console.log(`${file}: ${exists ? '✅ EXISTS' : '❌ MISSING'}`);
});

console.log('');
console.log('=== GOOGLE TOKEN CHECK ===');
if (fs.existsSync('google-token.json')) {
  try {
    const token = JSON.parse(fs.readFileSync('google-token.json', 'utf8'));
    console.log('✅ Google token file readable');
    console.log('Token keys:', Object.keys(token));
  } catch (error) {
    console.log('❌ Error reading google-token.json:', error.message);
  }
} else {
  console.log('❌ google-token.json not found');
}