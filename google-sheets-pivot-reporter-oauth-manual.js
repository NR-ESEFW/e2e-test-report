#!/usr/bin/env node

/**
 * Google Sheets Pivot Table and Chart Generator - OPTIMIZED VERSION
 * 
 * Key optimizations:
 * 1. Uses batchGet to fetch ALL sheets in ONE API call
 * 2. Minimal console logging
 * 3. Efficient data processing
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

class GoogleSheetsPivotReporterOAuth {
  constructor(spreadsheetId) {
    this.spreadsheetId = spreadsheetId;
    this.sheets = null;
    this.oauth2Client = null;
    this.allData = [];
    this.tokenPath = path.join(process.cwd(), 'google-token.json');
    this.sheetSummaries = [];
    this.indexSheetRows = null;
  }

  async authenticate(authCode) {
    console.log('🔐 Authenticating...');
    
    const credentialsPath = path.join(process.cwd(), 'oauth-credentials.json');
    if (!fs.existsSync(credentialsPath)) {
      throw new Error('❌ oauth-credentials.json not found');
    }

    const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;

    this.oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0] || 'http://localhost');

    if (fs.existsSync(this.tokenPath)) {
      const token = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
      this.oauth2Client.setCredentials(token);
      
      // Auto-refresh token
      this.oauth2Client.on('tokens', (newTokens) => {
        const updatedTokens = { ...token, ...newTokens };
        fs.writeFileSync(this.tokenPath, JSON.stringify(updatedTokens));
      });
      
      // Refresh if expiring soon
      const expiryDate = token.expiry_date || 0;
      if (expiryDate && expiryDate < Date.now() + 60000) {
        try {
          const { credentials: newCreds } = await this.oauth2Client.refreshAccessToken();
          fs.writeFileSync(this.tokenPath, JSON.stringify({ ...token, ...newCreds }));
        } catch (e) {
          console.warn('⚠️ Token refresh failed, continuing with existing token');
        }
      }
    } else if (authCode) {
      const { tokens } = await this.oauth2Client.getToken(authCode);
      this.oauth2Client.setCredentials(tokens);
      fs.writeFileSync(this.tokenPath, JSON.stringify(tokens));
    } else {
      const authUrl = this.oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
      throw new Error(`❌ No token. Visit: ${authUrl}\nThen run: node script.js <code>`);
    }

    this.sheets = google.sheets({ version: 'v4', auth: this.oauth2Client });
    console.log('✅ Authenticated\n');
  }

  async fetchAllSheetsData() {
    console.log('📊 Fetching spreadsheet metadata...');
    
    // Step 1: Get all sheet names (single API call)
    const metadata = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
    });
    
    const allSheetTitles = metadata.data.sheets.map(s => s.properties.title);
    const sheetNames = allSheetTitles.filter(name => name.toLowerCase() !== 'index');
    
    console.log(`   Found ${sheetNames.length} sheets`);

    // Step 2: Build ranges for batchGet (fetch ALL sheets in ONE call)
    const ranges = allSheetTitles.map(name => `'${name.trim()}'`);
    
    console.log('📥 Fetching all sheet data in batch...');
    const batchResponse = await this.sheets.spreadsheets.values.batchGet({
      spreadsheetId: this.spreadsheetId,
      ranges: ranges,
    });

    // Step 3: Process all sheets
    const allData = [];
    this.sheetSummaries = [];
    this.indexSheetRows = null;

    batchResponse.data.valueRanges.forEach((valueRange, idx) => {
      const sheetName = allSheetTitles[idx];
      const rows = valueRange.values;

      // Handle Index sheet separately
      if (sheetName.toLowerCase() === 'index') {
        if (rows && rows.length > 1) {
          this.indexSheetRows = rows;
        }
        return;
      }

      if (!rows || rows.length === 0) {
        this.sheetSummaries.push({ name: sheetName, rowCount: 0, headerFound: false });
        return;
      }

      // Find header row
      const headerRowIdx = rows.findIndex(row => 
        row.some(cell => cell && cell.toLowerCase().includes('tester'))
      );
      
      if (headerRowIdx === -1) {
        this.sheetSummaries.push({ name: sheetName, rowCount: 0, headerFound: false });
        return;
      }

      const header = rows[headerRowIdx];
      const testerIdx = header.findIndex(cell => cell && cell.toLowerCase().includes('tester'));
      const statusIdx = header.findIndex(cell => cell && cell.toLowerCase().includes('overall status'));
      const defectIdx = header.findIndex(cell => cell && cell.toLowerCase().includes('defect'));
      const commentsIdx = header.findIndex(cell => cell && cell.toLowerCase().includes('comment'));
      const iterationIdx = header.findIndex(cell => cell && cell.toLowerCase().includes('iteration'));

      const rowCount = rows.length - headerRowIdx - 1;
      this.sheetSummaries.push({ name: sheetName, rowCount, headerFound: true });

      // Process data rows
      for (let i = headerRowIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const tester = row[testerIdx] || '';
        // Default empty status to 'Not Started'
        const rawStatus = row[statusIdx] || '';
        const status = rawStatus.trim() ? rawStatus.trim() : 'Not Started';
        
        // Skip rows with no tester name
        if (!tester.trim()) continue;
        
        const defect = defectIdx !== -1 ? row[defectIdx] || '' : '';
        const comments = commentsIdx !== -1 ? row[commentsIdx] || '' : '';
        
        let iteration = '';
        if (iterationIdx !== -1) {
          iteration = row[iterationIdx] || '';
        } else {
          const match = sheetName.match(/(itr[- ]?\d+)/i);
          iteration = match ? match[1] : '';
        }
        iteration = iteration.replace(/itr[- ]?/i, '').trim();

        allData.push({ tester, jiraTicket: sheetName, iteration, overallStatus: status, defect, comments });
      }
    });

    this.allData = allData;
    console.log(`✅ Processed ${sheetNames.length} sheets, ${allData.length} rows\n`);
    return allData;
  }

  generateHTMLReport() {
    const statusColors = {
      'Passed': '#81c784',
      'Failed': '#ffb300',
      'Blocked': '#ff8a80',
      'Not Started': '#bdbdbd',
      'In Progress': '#ffe082',
    };
    const statusOrder = ['Passed', 'Failed', 'Blocked', 'In Progress', 'Not Started'];

    // Get unique statuses
    const statusSet = new Set(this.allData.map(row => row.overallStatus).filter(s => s));
    const statusList = statusOrder.filter(s => statusSet.has(s));
    statusSet.forEach(s => { if (!statusList.includes(s)) statusList.push(s); });

    // Group data by tester (skip empty tester names)
    const grouped = {};
    this.allData.forEach(row => {
      const key = row.tester?.trim();
      if (!key) return;
      if (!grouped[key]) grouped[key] = { tester: key, rows: [], statusCounts: {} };
      grouped[key].rows.push(row);
      grouped[key].statusCounts[row.overallStatus] = (grouped[key].statusCounts[row.overallStatus] || 0) + 1;
    });

    // Sort alphabetically
    const sortedTesters = Object.keys(grouped).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    
    const data = sortedTesters.map(testerName => {
      const group = grouped[testerName];
      return {
        testerName,
        statusCounts: statusList.map(status => group.statusCounts[status] || 0),
        total: group.rows.length,
      };
    });

    // Index stories table
    let indexStoriesTable = '';
    if (this.indexSheetRows?.length > 1) {
      const header = this.indexSheetRows[0];
      const bodyRows = this.indexSheetRows.slice(1).filter(row => row.some(cell => cell));
      
      let testStoryIdx = 3, descIdx = 2, statusIdx = 4;
      header.forEach((cell, i) => {
        const lc = cell?.toLowerCase() || '';
        if (lc.includes('test story')) testStoryIdx = i;
        if (lc.includes('description')) descIdx = i;
        if (lc.includes('status')) statusIdx = i;
      });

      const statusCountsMap = {};
      bodyRows.forEach(row => {
        const status = row[statusIdx] || '';
        if (status.trim()) { // Only count non-empty statuses
          statusCountsMap[status] = (statusCountsMap[status] || 0) + 1;
        }
      });

      // Filter to only show statuses with count > 0
      const filteredLabels = Object.keys(statusCountsMap).filter(s => statusCountsMap[s] > 0);
      const filteredCounts = filteredLabels.map(s => statusCountsMap[s]);
      const filteredColors = filteredLabels.map(s => statusColors[s] || '#ffe082');

      // Jira/Xray base URL
      const jiraBaseUrl = 'https://new-relic.atlassian.net/projects/NR?selectedItem=com.atlassian.plugins.atlassian-connect-plugin:com.xpandit.plugins.xray__testing-board#!page=test-run&testExecutionKey=NR-488556&testPlanId=725086&testKey=';

      indexStoriesTable = `
        <h2>Index of Stories</h2>
        <table>
          <thead><tr><th>Test Story</th><th>Description</th><th>Status</th></tr></thead>
          <tbody>
            ${bodyRows.map(row => {
              const testStory = row[testStoryIdx] || '';
              const status = row[statusIdx] || '';
              const color = statusColors[status] || '#e0e0e0';
              const jiraLink = testStory ? `<a href="${jiraBaseUrl}${testStory}" target="_blank" style="color:#1a73e8;text-decoration:none;font-weight:bold;">${testStory}</a>` : '';
              return `<tr><td>${jiraLink}</td><td>${row[descIdx] || ''}</td><td style="background:${color};font-weight:bold;">${status}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
        <h3>Stories by Status</h3>
        <canvas id="indexStoriesBarChart" width="600" height="250"></canvas>
        <script>
          window.addEventListener('DOMContentLoaded', function() {
            new Chart(document.getElementById('indexStoriesBarChart').getContext('2d'), {
              type: 'bar',
              data: { labels: ${JSON.stringify(filteredLabels)}, datasets: [{ label: 'Count', data: ${JSON.stringify(filteredCounts)}, backgroundColor: ${JSON.stringify(filteredColors)} }] },
              options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
            });
          });
        </script>`;
    }

    // Chart data
    const statusCounts = statusList.map(status => this.allData.filter(row => row.overallStatus === status).length);
    const barLabels = data.map(row => row.testerName);
    const barDataSets = statusList.map((status, idx) => ({
      label: status,
      data: data.map(row => row.statusCounts[idx]),
      backgroundColor: statusColors[status] || '#e0e0e0',
    }));

    // Dropdowns
    const testerOptions = sortedTesters.map(t => `<option value="${t}">${t}</option>`).join('');
    const statusOptions = statusList.map(s => `<option value="${s}">${s}</option>`).join('');

    // Aggregate blocks
    const aggregateBlocks = data.map(row => {
      const group = grouped[row.testerName];
      const statusSummary = statusOrder.filter(s => group.statusCounts[s]).map(s => 
        `<span style="background:${statusColors[s]};padding:2px 8px;border-radius:6px;margin-right:6px;">${s}: <b>${group.statusCounts[s]}</b></span>`
      ).join(' ');
      
      const allStatuses = Object.keys(group.statusCounts).filter(s => group.statusCounts[s] > 0);
      const sortedRows = statusOrder.flatMap(status => group.rows.filter(r => r.overallStatus === status));
      
      return `
        <div class="aggregate-block" data-tester="${row.testerName}" data-statuses="${allStatuses.join(',')}">
          <table>
            <thead>
              <tr style="background:#f3f3fa;"><td colspan="6"><strong>${group.tester}</strong> — ${statusSummary}</td></tr>
              <tr><th>Tester</th><th>Jira Tickets</th><th>Iterations</th><th>Status</th><th>Defects</th><th>Comments</th></tr>
            </thead>
            <tbody>
              ${sortedRows.map(r => `
                <tr class="row-status-${r.overallStatus.replace(/\s/g, '_')}">
                  <td>${r.tester}</td><td>${r.jiraTicket}</td><td>${r.iteration}</td>
                  <td style="background:${statusColors[r.overallStatus] || '#e0e0e0'};font-weight:bold;">${r.overallStatus}</td>
                  <td style="color:#d32f2f;font-weight:bold;">${r.defect}</td><td>${r.comments}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }).join('');

    // Pivot table rows
    const pivotTableRows = data.map(row => {
      const cells = statusList.map((status, idx) => {
        const count = row.statusCounts[idx];
        return `<td style="background:${count > 0 ? statusColors[status] : '#fff'};">${count}</td>`;
      }).join('');
      return `<tr><td>${row.testerName}</td>${cells}<td><strong>${row.total}</strong></td></tr>`;
    }).join('');

    const now = new Date();
    const pstTime = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: true });
    const istTime = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>O2C Test Status Report</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f8f9ff; }
    .container { max-width: 1200px; margin: 40px auto; background: #fff; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.12); padding: 32px; }
    h1 { color: #764ba2; }
    h2 { color: #333; margin-top: 40px; }
    table { width: 100%; border-collapse: collapse; margin: 24px 0; }
    th, td { padding: 10px 14px; border-bottom: 1px solid #eee; text-align: left; }
    th { background: #764ba2; color: #fff; }
    tr:hover { background: #f3f3fa; }
    .hidden { display: none; }
    .filter-section { margin: 20px 0; padding: 16px; background: #f3f3fa; border-radius: 8px; }
    .filter-section select { padding: 8px 12px; margin-right: 16px; border-radius: 4px; border: 1px solid #ccc; }
    .aggregate-block { margin-bottom: 24px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div class="container">
    <div style="text-align:center;margin-bottom:24px;background:#f3f3fa;padding:32px 0;border-radius:12px;">
      <img src="nr_image_logo.png" alt="New Relic Logo" style="height:60px;margin-bottom:16px;">
      <h1 style="margin:0;font-size:2.5rem;color:#764ba2;">O2C E2E Test Status Report</h1>
    </div>
    <p style="text-align:center;">Generated: <b>${pstTime} PST</b> | <b>${istTime} IST</b></p>
    
    ${indexStoriesTable}
    
    <h2>Tester Name × Overall Status</h2>
    <table>
      <thead>
        <tr>
          <th>Tester Name</th>
          ${statusList.map(s => `<th style="background:${statusColors[s] || '#e0e0e0'};color:#222;">${s}</th>`).join('')}
          <th>Total</th>
        </tr>
      </thead>
      <tbody>${pivotTableRows}</tbody>
    </table>

    <h2>Filter by Tester / Status</h2>
    <div class="filter-section">
      <label>Tester: </label>
      <select id="testerSelect" onchange="filterTesterStatus()">
        <option value="ALL">All Testers</option>${testerOptions}
      </select>
      <label>Status: </label>
      <select id="statusSelect" onchange="filterTesterStatus()">
        <option value="ALL">All Statuses</option>${statusOptions}
      </select>
    </div>

    <h2>Details by Tester</h2>
    ${aggregateBlocks}

    <h2>Status Counts by Tester</h2>
    <canvas id="testerBarChart" width="800" height="300"></canvas>

    <h2>Status Distribution</h2>
    <div style="display:flex;align-items:center;justify-content:center;gap:40px;flex-wrap:wrap;">
      <canvas id="statusPieChart" width="300" height="300"></canvas>
      <div class="metrics-summary">
        <h3 style="margin-top:0;">Summary</h3>
        <table style="min-width:250px;">
          <thead>
            <tr><th>Status</th><th>Count</th><th>%</th></tr>
          </thead>
          <tbody>
            ${statusList.map((status, idx) => {
              const count = statusCounts[idx];
              const total = statusCounts.reduce((a, b) => a + b, 0);
              const percent = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
              const color = statusColors[status] || '#e0e0e0';
              return `<tr>
                <td style="background:${color};font-weight:bold;">${status}</td>
                <td style="text-align:center;font-weight:bold;">${count}</td>
                <td style="text-align:center;">${percent}%</td>
              </tr>`;
            }).join('')}
            <tr style="border-top:2px solid #333;">
              <td><strong>Total</strong></td>
              <td style="text-align:center;"><strong>${statusCounts.reduce((a, b) => a + b, 0)}</strong></td>
              <td style="text-align:center;"><strong>100%</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    function filterTesterStatus() {
      var tester = document.getElementById('testerSelect').value;
      var status = document.getElementById('statusSelect').value;
      document.querySelectorAll('.aggregate-block').forEach(function(block) {
        var t = block.dataset.tester;
        var s = (block.dataset.statuses || '').split(',');
        var show = (tester === 'ALL' || t === tester) && (status === 'ALL' || s.includes(status));
        block.classList.toggle('hidden', !show);
        block.querySelectorAll('tbody tr').forEach(function(tr) {
          var cell = tr.querySelector('td:nth-child(4)');
          tr.style.display = (status === 'ALL' || cell?.textContent.trim() === status) ? '' : 'none';
        });
      });
    }
    window.onload = function() {
      new Chart(document.getElementById('statusPieChart').getContext('2d'), {
        type: 'pie',
        data: { labels: ${JSON.stringify(statusList)}, datasets: [{ data: ${JSON.stringify(statusCounts)}, backgroundColor: ${JSON.stringify(statusList.map(s => statusColors[s] || '#e0e0e0'))} }] },
        options: { plugins: { legend: { position: 'bottom' } } }
      });
      new Chart(document.getElementById('testerBarChart').getContext('2d'), {
        type: 'bar',
        data: { labels: ${JSON.stringify(barLabels)}, datasets: ${JSON.stringify(barDataSets)} },
        options: { plugins: { legend: { position: 'top' } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } }
      });
    };
  </script>
</body>
</html>`;
  }

  saveReports() {
    const html = this.generateHTMLReport();
    fs.writeFileSync('o2c-test-status-report.html', html, 'utf8');
    return { htmlPath: 'o2c-test-status-report.html' };
  }
}

export default GoogleSheetsPivotReporterOAuth;

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      const authCode = process.env.GOOGLE_AUTH_CODE || process.argv[2];
      
      if (!spreadsheetId) {
        console.error('❌ Set GOOGLE_SHEETS_SPREADSHEET_ID environment variable');
        process.exit(1);
      }
      
      const reporter = new GoogleSheetsPivotReporterOAuth(spreadsheetId);
      await reporter.authenticate(authCode);
      await reporter.fetchAllSheetsData();
      const { htmlPath } = reporter.saveReports();
      console.log(`✅ Report saved: ${path.resolve(htmlPath)}`);
    } catch (err) {
      console.error('❌ Error:', err.message);
      process.exit(1);
    }
  })();
}