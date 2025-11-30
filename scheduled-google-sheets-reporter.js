// scripts/scheduled-google-sheets-reporter.js
// This script runs the Google Sheets report generator every 6 hours via cron or a scheduler.
// Usage: node scripts/scheduled-google-sheets-reporter.js

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import the main reporter class
import GoogleSheetsPivotReporterOAuth from './google-sheets-pivot-reporter-oauth-manual.js';

async function runReport() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '<YOUR_SPREADSHEET_ID>';
    const authCode = process.env.GOOGLE_AUTH_CODE || undefined; // Use stored token
    if (!spreadsheetId) {
      console.error('❌ Please set GOOGLE_SHEETS_SPREADSHEET_ID in your environment or update the script.');
      process.exit(1);
    }
    const reporter = new GoogleSheetsPivotReporterOAuth(spreadsheetId);
    await reporter.authenticate(authCode);
    await reporter.fetchAllSheetsData();
    const { htmlPath } = reporter.saveReports();
    const fullPath = path.resolve(htmlPath);
    const fileUrl = `file://${fullPath}`;
    console.log('✅ Scheduled report generation complete!');
    console.log(`🔗 HTML report saved at: ${htmlPath}`);
    console.log(`👉 Copy and paste this link into your browser to view the report:\n${fileUrl}`);
  } catch (err) {
    console.error('❌ Error during scheduled report generation:', err);
    process.exit(1);
  }
}

runReport();
