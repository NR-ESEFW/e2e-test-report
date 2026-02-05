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
      'Passed': '#4CAF50',
      'Failed': '#F44336',
      'Blocked': '#E91E63',
      'Not Started': '#9E9E9E',
      'In Progress': '#FF9800',
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
      if (!grouped[key]) grouped[key] = { 
        tester: key, 
        rows: [], 
        statusCounts: {}, 
        ticketIterations: new Map() // Track iterations per ticket
      };
      grouped[key].rows.push(row);
      grouped[key].statusCounts[row.overallStatus] = (grouped[key].statusCounts[row.overallStatus] || 0) + 1;
      
      // Track iterations per ticket for this tester
      const ticket = row.jiraTicket;
      if (!grouped[key].ticketIterations.has(ticket)) {
        grouped[key].ticketIterations.set(ticket, new Set());
      }
      grouped[key].ticketIterations.get(ticket).add(row.iteration || '1');
    });

    // Sort alphabetically
    const sortedTesters = Object.keys(grouped).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    
    const data = sortedTesters.map(testerName => {
      const group = grouped[testerName];
      const uniqueTicketCount = group.ticketIterations.size;
      
      // Build ticket iteration details
      const ticketDetails = [];
      for (const [ticket, iterations] of group.ticketIterations) {
        const count = iterations.size;
        ticketDetails.push({ ticket, count });
      }
      
      return {
        testerName,
        statusCounts: statusList.map(status => group.statusCounts[status] || 0),
        total: group.rows.length,
        uniqueTicketCount: uniqueTicketCount,
        ticketDetails: ticketDetails
      };
    });

    // Index stories table
    let indexStoriesTable = '';
    if (this.indexSheetRows?.length > 1) {
      const header = this.indexSheetRows[0];
      const bodyRows = this.indexSheetRows.slice(1).filter(row => row.some(cell => cell));
      
      let testScenarioIdx = 0, testExecutionIdx = 1, testStoryIdx = 3, descIdx = 2, statusIdx = 4;
      header.forEach((cell, i) => {
        const lc = cell?.toLowerCase() || '';
        if (lc.includes('test scenario')) testScenarioIdx = i;
        if (lc.includes('test execution')) testExecutionIdx = i;
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
          <thead><tr><th>Test Scenario</th><th>Test Execution</th><th>Test Story</th><th>Description</th><th>Status</th></tr></thead>
          <tbody>
            ${bodyRows.map(row => {
              const testScenario = row[testScenarioIdx] || '';
              const testExecution = row[testExecutionIdx] || '';
              const testStory = row[testStoryIdx] || '';
              const description = row[descIdx] || '';
              const status = row[statusIdx] || '';
              const color = statusColors[status] || '#e0e0e0';
              
              // Create hyperlink for Test Scenario if it looks like a hyperlink
              let testScenarioCell = testScenario;
              if (testScenario && testScenario.includes('http')) {
                // If it's already a hyperlink, extract URL and text
                const urlMatch = testScenario.match(/https?:\/\/[^\s)]+/);
                const linkText = testScenario.replace(/https?:\/\/[^\s)]+/, '').trim().replace(/[()]/g, '') || 'Link';
                if (urlMatch) {
                  testScenarioCell = `<a href="${urlMatch[0]}" target="_blank" style="color:#1a73e8;text-decoration:none;font-weight:bold;">${linkText}</a>`;
                }
              } else if (testScenario && testScenario.startsWith('NR-')) {
                // If it's a ticket number, create Jira link
                testScenarioCell = `<a href="${jiraBaseUrl}${testScenario}" target="_blank" style="color:#1a73e8;text-decoration:none;font-weight:bold;">${testScenario}</a>`;
              }
              
              const jiraLink = testStory ? `<a href="${jiraBaseUrl}${testStory}" target="_blank" style="color:#1a73e8;text-decoration:none;font-weight:bold;">${testStory}</a>` : '';
              return `<tr><td>${testScenarioCell}</td><td>${testExecution}</td><td>${jiraLink}</td><td>${description}</td><td style="background:${color};font-weight:bold;padding:6px;border-radius:4px;color:white;text-align:center;">${status}</td></tr>`;
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
      
      const ticketDetailsHTML = row.ticketDetails.map((detail, index) => {
        const bgColor = index % 2 === 0 ? '#f8fafc' : '#ffffff';
        const borderColor = detail.count > 3 ? '#dc2626' : detail.count > 1 ? '#f59e0b' : '#10b981';
        return `
          <div style="
            background: ${bgColor};
            border-left: 4px solid ${borderColor};
            margin: 4px 0;
            padding: 8px 12px;
            border-radius: 6px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            transition: all 0.2s ease;
          " onmouseover="this.style.boxShadow='0 4px 8px rgba(0,0,0,0.15)'" onmouseout="this.style.boxShadow='0 1px 3px rgba(0,0,0,0.1)'">
            <span style="font-weight: 600; color: #374151; font-size: 0.9em;">${detail.ticket}</span>
            <span style="
              background: linear-gradient(135deg, ${borderColor}15, ${borderColor}25);
              color: ${borderColor === '#dc2626' ? '#dc2626' : borderColor === '#f59e0b' ? '#d97706' : '#059669'};
              padding: 2px 8px;
              border-radius: 12px;
              font-size: 0.8em;
              font-weight: 700;
              margin-left: 8px;
              border: 1px solid ${borderColor}40;
            ">Iteration Cases: ${detail.count}</span>
          </div>`;
      }).join('');
      
      return `
        <div class="aggregate-block" data-tester="${row.testerName}" data-statuses="${allStatuses.join(',')}">
          <div style="
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 12px;
            margin: 20px 0;
            box-shadow: 0 8px 32px rgba(102, 126, 234, 0.2);
            overflow: hidden;
          ">
            <!-- Header Section -->
            <div style="
              background: rgba(255, 255, 255, 0.95);
              padding: 20px;
              border-bottom: 1px solid rgba(102, 126, 234, 0.1);
            ">
              <h3 style="
                margin: 0 0 12px 0;
                color: #1f2937;
                font-size: 1.4em;
                font-weight: 700;
                display: flex;
                align-items: center;
              ">
                <span style="
                  background: linear-gradient(135deg, #667eea, #764ba2);
                  -webkit-background-clip: text;
                  -webkit-text-fill-color: transparent;
                  background-clip: text;
                ">${row.testerName}</span>
                <span style="
                  background: #374151;
                  color: white;
                  padding: 4px 10px;
                  border-radius: 20px;
                  font-size: 0.7em;
                  margin-left: 12px;
                  font-weight: 600;
                ">TESTER</span>
              </h3>
              
              <!-- Status Summary -->
              <div style="margin-bottom: 16px;">
                ${statusSummary}
              </div>
              
              <!-- Total Tickets Header -->
              <div style="
                background: linear-gradient(135deg, #3b82f6, #1d4ed8);
                color: white;
                padding: 12px 16px;
                border-radius: 8px;
                margin-bottom: 12px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
              ">
                <span style="font-weight: 600; font-size: 1.05em;">📋 Total Tickets under ${row.testerName}</span>
                <span style="
                  background: rgba(255, 255, 255, 0.2);
                  padding: 4px 12px;
                  border-radius: 20px;
                  font-weight: 700;
                  font-size: 1.1em;
                ">${row.uniqueTicketCount}</span>
              </div>
              
              <!-- Tickets List -->
              <div style="
                background: #f9fafb;
                border-radius: 8px;
                padding: 12px;
                border: 1px solid #e5e7eb;
              ">
                ${ticketDetailsHTML}
              </div>
            </div>
            
            <!-- Table Section -->
            <table style="width: 100%; border-collapse: collapse; background: white;">
              <thead>
                <tr style="background: linear-gradient(135deg, #667eea, #764ba2); color: white;">
                  <th style="padding: 12px; text-align: left; font-weight: 600;">👤 Tester</th>
                  <th style="padding: 12px; text-align: left; font-weight: 600;">🎫 Jira Tickets</th>
                  <th style="padding: 12px; text-align: left; font-weight: 600;">🔄 Iterations</th>
                  <th style="padding: 12px; text-align: left; font-weight: 600;">📊 Status</th>
                  <th style="padding: 12px; text-align: left; font-weight: 600;">🐛 Defects</th>
                  <th style="padding: 12px; text-align: left; font-weight: 600;">💬 Comments</th>
                </tr>
              </thead>
            <tbody>
              ${sortedRows.map((r, index) => {
                const rowBg = index % 2 === 0 ? '#ffffff' : '#f8fafc';
                return `
                <tr class="row-status-${r.overallStatus.replace(/\s/g, '_')}" style="
                  background: ${rowBg};
                  transition: all 0.2s ease;
                " onmouseover="this.style.background='#e0e7ff'" onmouseout="this.style.background='${rowBg}'">
                  <td style="padding: 12px; color: #374151; font-weight: 500;">${r.tester}</td>
                  <td style="padding: 12px; color: #1f2937; font-weight: 600;">${r.jiraTicket}</td>
                  <td style="padding: 12px; color: #6b7280;">${r.iteration}</td>
                  <td style="
                    padding: 8px;
                    background: ${statusColors[r.overallStatus] || '#e0e0e0'};
                    color: ${r.overallStatus === 'Passed' ? '#065f46' : r.overallStatus === 'Failed' ? '#92400e' : r.overallStatus === 'Blocked' ? '#7f1d1d' : '#374151'};
                    font-weight: 700;
                    border-radius: 6px;
                    text-align: center;
                    text-transform: uppercase;
                    font-size: 0.85em;
                    letter-spacing: 0.5px;
                  ">${r.overallStatus}</td>
                  <td style="padding: 12px; color: #dc2626; font-weight: 600; font-size: 0.9em;">${r.defect}</td>
                  <td style="padding: 12px; color: #4b5563; font-size: 0.9em; line-height: 1.4;">${r.comments}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
          </div>
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
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      margin: 0;
      padding: 20px;
      line-height: 1.6;
    }
    .container { 
      max-width: 1400px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.15);
      overflow: hidden;
    }
    h1 { 
      color: #ffffff;
      text-align: center;
      margin: 0;
      padding: 40px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      font-size: 2.8rem;
      font-weight: 800;
      text-shadow: 0 4px 8px rgba(0,0,0,0.2);
    }
    h2 { 
      color: #1f2937;
      margin: 40px 0 20px 0;
      font-size: 1.8rem;
      font-weight: 700;
      border-left: 5px solid #667eea;
      padding-left: 15px;
    }
    table { 
      width: 100%;
      border-collapse: collapse;
      margin: 24px 0;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    th, td { 
      padding: 16px;
      text-align: left;
      border-bottom: 1px solid #e5e7eb;
    }
    th { 
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: #ffffff;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-size: 0.9em;
    }
    tr:hover { 
      background: #f0f4ff !important;
      transform: translateY(-1px);
      transition: all 0.2s ease;
    }
    .hidden { display: none; }
    .filter-section { 
      margin: 30px 0;
      padding: 24px;
      background: linear-gradient(135deg, #f8fafc, #e2e8f0);
      border-radius: 16px;
      border: 1px solid #cbd5e1;
      box-shadow: 0 4px 12px rgba(0,0,0,0.05);
    }
    .filter-section select { 
      padding: 12px 16px;
      margin-right: 16px;
      border-radius: 8px;
      border: 2px solid #cbd5e1;
      background: white;
      font-weight: 500;
      transition: all 0.2s ease;
    }
    .filter-section select:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    .aggregate-block { 
      margin-bottom: 40px;
    }
    .main-content {
      padding: 40px;
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div class="container">
    <div style="text-align:center; background: linear-gradient(135deg, #00AC69 0%, #1CE783 100%); padding: 60px 40px; position: relative; overflow: hidden;">
      <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: radial-gradient(circle at 20% 80%, rgba(255,255,255,0.15) 0%, transparent 50%), radial-gradient(circle at 80% 20%, rgba(255,255,255,0.15) 0%, transparent 50%);"></div>
      <div style="position: relative; z-index: 2;">
        <div style="margin-bottom: 30px; text-align: center;">
          <img src="NEWR_BIG.D.png" alt="New Relic Logo" style="height: 100px; margin-bottom: 20px;" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
          <div style="display: none;">
            <span style="font-size: 2.5rem; font-weight: 900; color: white; text-shadow: 0 4px 8px rgba(0,0,0,0.3); letter-spacing: 2px;">NEW RELIC</span>
          </div>
        </div>
        <h1 style="margin: 0; font-size: 2.8rem; font-weight: 800; color: #ffffff; text-shadow: 0 4px 8px rgba(0,0,0,0.3);">O2C E2E Test Status Report</h1>
      </div>
    </div>
    <div class="main-content">
      <p style="text-align:center; color: #6b7280; font-size: 1.1em; margin-bottom: 40px;">
        <strong style="color: #374151;">Generated:</strong> 
        <span style="background: #ddd6fe; color: #5b21b6; padding: 4px 8px; border-radius: 6px; font-weight: 600;">${pstTime} PST</span> | 
        <span style="background: #ddd6fe; color: #5b21b6; padding: 4px 8px; border-radius: 6px; font-weight: 600;">${istTime} IST</span>
      </p>
    
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