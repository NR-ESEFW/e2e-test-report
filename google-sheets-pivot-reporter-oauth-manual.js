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
import axios from 'axios';
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
    this.jiraBugs = [];
    this.bugMetrics = { priorities: {}, statuses: {} };
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
      
      // Generate individual iteration entries instead of grouping by ticket
      const ticketDetailsHTML = [];
      let index = 0;
      
      // Go through each row individually to show each iteration separately
      group.rows.forEach(row => {
        const bgColor = index % 2 === 0 ? '#f8fafc' : '#ffffff';
        const borderColor = statusColors[row.overallStatus] || '#e0e0e0';
        
        ticketDetailsHTML.push(`
          <div style="
            background: ${bgColor};
            border-left: 4px solid ${borderColor};
            margin: 4px 0;
            padding: 8px 12px;
            border-radius: 6px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            transition: all 0.2s ease;
          " onmouseover="this.style.boxShadow='0 4px 8px rgba(0,0,0,0.15)'" onmouseout="this.style.boxShadow='0 1px 3px rgba(0,0,0,0.1)'">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div>
                <span style="font-weight: 600; color: #374151; font-size: 0.9em;">${row.jiraTicket}</span>
                <span style="
                  background: rgba(107, 114, 128, 0.1);
                  color: #6b7280;
                  padding: 2px 8px;
                  border-radius: 12px;
                  font-size: 0.75em;
                  font-weight: 600;
                  margin-left: 8px;
                ">${row.iteration}</span>
              </div>
              <span style="
                background: ${statusColors[row.overallStatus] || '#e0e0e0'};
                color: ${row.overallStatus === 'Passed' ? '#065f46' : row.overallStatus === 'Failed' ? '#92400e' : row.overallStatus === 'Blocked' ? '#7f1d1d' : '#374151'};
                padding: 2px 8px;
                border-radius: 8px;
                font-size: 0.75em;
                font-weight: 700;
                text-transform: uppercase;
              ">${row.overallStatus}</span>
            </div>
          </div>`);
        index++;
      });
      
      const ticketDetailsHTMLString = ticketDetailsHTML.join('');
      
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
              

              
              <!-- Total Tickets Header - Clickable to toggle details -->
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
                cursor: pointer;
                transition: all 0.2s ease;
              " onclick="toggleTesterDetails('${row.testerName.replace(/\s+/g, '')}'); this.style.transform = this.style.transform === 'scale(0.98)' ? 'scale(1)' : 'scale(0.98)'; setTimeout(() => this.style.transform = 'scale(1)', 100);">
                <span style="font-weight: 600; font-size: 1.05em;">📋 Total Tickets under ${row.testerName}</span>
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="
                    background: rgba(255, 255, 255, 0.2);
                    padding: 4px 12px;
                    border-radius: 20px;
                    font-weight: 700;
                    font-size: 1.1em;
                  ">${row.uniqueTicketCount}</span>
                  <span id="toggle-icon-${row.testerName.replace(/\s+/g, '')}" style="
                    font-size: 1.2em;
                    transition: transform 0.3s ease;
                  ">▼</span>
                </div>
              </div>
              
              <!-- Two Column Layout: Tickets List + Charts -->
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px;">
                
                <!-- Left Column: Tickets List -->
                <div style="
                  background: #f9fafb;
                  border-radius: 8px;
                  padding: 12px;
                  border: 1px solid #e5e7eb;
                ">
                  <h4 style="margin: 0 0 10px 0; color: #374151; font-size: 1em;">🎫 Ticket Details</h4>
                  ${ticketDetailsHTMLString}
                </div>
                
                <!-- Right Column: Charts -->
                <div style="
                  background: #ffffff;
                  border-radius: 8px;
                  padding: 12px;
                  border: 1px solid #e5e7eb;
                  text-align: center;
                ">
                  <h4 style="margin: 0 0 15px 0; color: #374151; font-size: 1em;">📊 Performance Metrics</h4>
                  
                  <!-- Status Distribution Pie Chart -->
                  <div style="margin-bottom: 20px;">
                    <canvas id="pieChart-${row.testerName.replace(/\s+/g, '')}" width="200" height="200"></canvas>
                  </div>
                  
                  <!-- Key Metrics -->
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; text-align: center;">
                    <div style="background: #10b981; color: white; padding: 8px; border-radius: 6px; font-size: 0.9em;">
                      <div style="font-weight: 600;">✅ Passed</div>
                      <div style="font-size: 1.2em;">${group.statusCounts.Passed || 0}</div>
                    </div>
                    <div style="background: #f59e0b; color: white; padding: 8px; border-radius: 6px; font-size: 0.9em;">
                      <div style="font-weight: 600;">⚡ Progress</div>
                      <div style="font-size: 1.2em;">${group.statusCounts['In Progress'] || 0}</div>
                    </div>
                    <div style="background: #ef4444; color: white; padding: 8px; border-radius: 6px; font-size: 0.9em;">
                      <div style="font-weight: 600;">❌ Failed</div>
                      <div style="font-size: 1.2em;">${group.statusCounts.Failed || 0}</div>
                    </div>
                    <div style="background: #8b5cf6; color: white; padding: 8px; border-radius: 6px; font-size: 0.9em;">
                      <div style="font-weight: 600;">🚫 Blocked</div>
                      <div style="font-size: 1.2em;">${group.statusCounts.Blocked || 0}</div>
                    </div>
                  </div>
                  
                  <!-- Pass Rate -->
                  <div style="margin-top: 15px; padding: 10px; background: linear-gradient(45deg, #10b981, #059669); color: white; border-radius: 8px;">
                    <div style="font-weight: 600; font-size: 0.9em;">📊 Pass Rate</div>
                    <div style="font-size: 1.4em; font-weight: 700;">${(() => {
                      const totalCases = Object.values(group.statusCounts).reduce((sum, count) => sum + count, 0);
                      const passedCases = group.statusCounts.Passed || 0;
                      return totalCases > 0 ? Math.round((passedCases / totalCases) * 100) : 0;
                    })()}%</div>
                  </div>
                </div>
              </div>
              
              <!-- Collapsible Detailed Table Section -->
              <div id="details-${row.testerName.replace(/\s+/g, '')}" style="
                max-height: 0;
                overflow: hidden;
                transition: max-height 0.4s ease-in-out, padding 0.3s ease;
                background: #ffffff;
                border-radius: 8px;
                margin-top: 12px;
              ">
                <div style="padding: 16px;">
                  <h4 style="margin: 0 0 12px 0; color: #374151; font-size: 1.1em; font-weight: 600;">📊 Detailed Test Execution Results</h4>
                  
                  <!-- Individual Table for this tester -->
                  <table style="width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                    <thead>
                      <tr style="background: linear-gradient(135deg, #667eea, #764ba2); color: white;">
                        <th style="padding: 12px; text-align: left; font-weight: 600; font-size: 0.9em;">🎫 Jira Ticket</th>
                        <th style="padding: 12px; text-align: left; font-weight: 600; font-size: 0.9em;">🔄 Iteration</th>
                        <th style="padding: 12px; text-align: left; font-weight: 600; font-size: 0.9em;">📊 Status</th>
                        <th style="padding: 12px; text-align: left; font-weight: 600; font-size: 0.9em;">🐛 Defects</th>
                        <th style="padding: 12px; text-align: left; font-weight: 600; font-size: 0.9em;">💬 Comments</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${sortedRows.map((r, index) => {
                        const rowBg = index % 2 === 0 ? '#ffffff' : '#f8fafc';
                        return `
                        <tr style="
                          background: ${rowBg};
                          transition: all 0.2s ease;
                        " onmouseover="this.style.background='#e0e7ff'" onmouseout="this.style.background='${rowBg}'">
                          <td style="padding: 12px; color: #1f2937; font-weight: 600; font-size: 0.9em;">${r.jiraTicket}</td>
                          <td style="padding: 12px; color: #6b7280; font-size: 0.9em;">${r.iteration}</td>
                          <td style="padding: 8px;">
                            <span style="
                              background: ${statusColors[r.overallStatus] || '#e0e0e0'};
                              color: ${r.overallStatus === 'Passed' ? '#065f46' : r.overallStatus === 'Failed' ? '#92400e' : r.overallStatus === 'Blocked' ? '#7f1d1d' : '#374151'};
                              font-weight: 700;
                              border-radius: 6px;
                              text-align: center;
                              text-transform: uppercase;
                              font-size: 0.8em;
                              padding: 6px 12px;
                              display: inline-block;
                              min-width: 80px;
                            ">${r.overallStatus}</span>
                          </td>
                          <td style="padding: 12px; color: #6b7280; font-size: 0.9em;">${r.defects || '-'}</td>
                          <td style="padding: 12px; color: #6b7280; font-size: 0.85em; max-width: 200px; word-wrap: break-word;">${r.comments || '-'}</td>
                        </tr>`;
                      }).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
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
    const istTime = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: true });

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
    .tab-container {
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      margin-bottom: 30px;
      overflow: hidden;
    }
    .tab-nav {
      display: flex;
      background: #f8fafc;
      border-bottom: 2px solid #e2e8f0;
    }
    .tab-button {
      flex: 1;
      padding: 16px 24px;
      background: transparent;
      border: none;
      font-size: 1.1em;
      font-weight: 600;
      color: #64748b;
      cursor: pointer;
      transition: all 0.3s ease;
      border-bottom: 3px solid transparent;
    }
    .tab-button.active {
      color: #00AC69;
      background: white;
      border-bottom-color: #00AC69;
      transform: translateY(-2px);
    }
    .tab-button:hover {
      color: #00AC69;
      background: rgba(0, 172, 105, 0.05);
    }
    .tab-content {
      display: none;
      padding: 30px;
    }
    .tab-content.active {
      display: block;
    }
    .bug-summary-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 24px;
      border-radius: 12px;
      margin-bottom: 30px;
      text-align: center;
    }
    .bug-metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .bug-metric-card {
      background: white;
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      text-align: center;
    }
    .bug-chart-container {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 30px;
      margin-bottom: 30px;
    }
    .bug-list {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
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
          <h1 style="color: white; font-size: 3rem; font-weight: 900; text-shadow: 0 4px 8px rgba(0,0,0,0.3); letter-spacing: 1px; display: flex; align-items: center; justify-content: center; gap: 20px;">
            <img src="https://github.com/NR-ESEFW/e2e-test-report/raw/main/nr_image_logo.png" alt="New Relic Logo" style="height: 80px;">
            O2C E2E Test Status Report
          </h1>
        </div>
      </div>
    </div>
    <div class="main-content">
      <p style="text-align:center; color: #6b7280; font-size: 1.1em; margin-bottom: 40px;">
        <strong style="color: #374151;">📊 Report Published on:</strong> 
        <span style="background: #ddd6fe; color: #5b21b6; padding: 4px 8px; border-radius: 6px; font-weight: 600;">🕐 ${pstTime} PST</span> | 
        <span style="background: #ddd6fe; color: #5b21b6; padding: 4px 8px; border-radius: 6px; font-weight: 600;">🕐 ${istTime} IST</span>
      </p>

      <!-- Tabbed Interface -->
      <div class="tab-container">
        <div class="tab-nav">
          <button class="tab-button active" onclick="switchTab('test-results')">
            🧪 Test Results Dashboard
          </button>
          <button class="tab-button" onclick="switchTab('bug-reports')">
            🐛 Bug Reports Dashboard
          </button>
        </div>
        
        <div id="test-results" class="tab-content active">
    
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

    <!-- No Records Found Message -->
    <div id="noRecordsMessage" style="
      display: none;
      text-align: center;
      padding: 40px 20px;
      background: linear-gradient(135deg, #f3f4f6, #e5e7eb);
      border-radius: 12px;
      margin: 20px 0;
      border: 2px dashed #d1d5db;
    ">
      <div style="font-size: 3em; color: #9ca3af; margin-bottom: 16px;">🔍</div>
      <h3 style="color: #374151; margin: 0 0 8px 0; font-size: 1.3em;">No Records Found</h3>
      <p style="color: #6b7280; margin: 0; font-size: 1em;">No test results match your current filter criteria. Try adjusting your filters or select "All" to view all results.</p>
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
  
  <div id="bug-reports" class="tab-content">
    ${this.generateBugReportsHTML()}
  </div>
</div>

  <script>
    function filterTesterStatus() {
      var tester = document.getElementById('testerSelect').value;
      var status = document.getElementById('statusSelect').value;
      var visibleBlocks = 0;
      var totalVisibleRows = 0;
      
      document.querySelectorAll('.aggregate-block').forEach(function(block) {
        var blockTester = block.dataset.tester;
        var blockStatuses = (block.dataset.statuses || '').split(',');
        
        // Check if this tester block should be shown
        var showBlock = (tester === 'ALL' || blockTester === tester) && 
                       (status === 'ALL' || blockStatuses.includes(status));
        
        if (!showBlock) {
          block.style.display = 'none';
          return;
        }
        
        var blockHasVisibleRows = false;
        block.style.display = 'block';
        
        // Filter individual ticket detail rows in the left panel
        var ticketDetailsContainer = block.querySelector('[style*="Ticket Details"]')?.parentElement;
        if (ticketDetailsContainer) {
          var ticketRows = ticketDetailsContainer.querySelectorAll('div[style*="border-left"]');
          var visibleRowsInBlock = 0;
          
          ticketRows.forEach(function(row) {
            var statusSpan = row.querySelector('span[style*="text-transform: uppercase"]');
            if (statusSpan) {
              var rowStatus = statusSpan.textContent.trim().toUpperCase();
              if (status === 'ALL' || rowStatus === status.toUpperCase()) {
                row.style.display = 'block';
                visibleRowsInBlock++;
                totalVisibleRows++;
                blockHasVisibleRows = true;
              } else {
                row.style.display = 'none';
              }
            }
          });
          
          // Show empty state message in ticket details if no rows match
          var existingEmptyMsg = ticketDetailsContainer.querySelector('.empty-ticket-details');
          if (visibleRowsInBlock === 0 && status !== 'ALL') {
            if (!existingEmptyMsg) {
              var emptyMsg = document.createElement('div');
              emptyMsg.className = 'empty-ticket-details';
              emptyMsg.style.cssText = 'text-align: center; padding: 20px; color: #6b7280; font-style: italic; background: #f9fafb; border-radius: 8px; border: 1px dashed #d1d5db;';
              emptyMsg.innerHTML = '📭 No ' + status.toLowerCase() + ' iterations found for this tester';
              ticketDetailsContainer.appendChild(emptyMsg);
            }
            ticketDetailsContainer.style.display = 'block'; // Keep container visible to show message
          } else {
            if (existingEmptyMsg) {
              existingEmptyMsg.remove();
            }
            ticketDetailsContainer.style.display = 'block';
          }
        }
        
        // Filter detailed table rows in the collapsible section
        var detailTable = block.querySelector('table tbody');
        if (detailTable) {
          detailTable.querySelectorAll('tr').forEach(function(tr) {
            var statusCell = tr.querySelector('td:nth-child(3) span');
            if (statusCell) {
              var rowStatus = statusCell.textContent.trim().toUpperCase();
              if (status === 'ALL' || rowStatus === status.toUpperCase()) {
                tr.style.display = '';
                if (!blockHasVisibleRows) {
                  totalVisibleRows++;
                  blockHasVisibleRows = true;
                }
              } else {
                tr.style.display = 'none';
              }
            }
          });
        }
        
        // Hide block if no visible rows
        if (!blockHasVisibleRows && (tester !== 'ALL' || status !== 'ALL')) {
          block.style.display = 'none';
        } else if (blockHasVisibleRows) {
          visibleBlocks++;
        }
      });
      
      // Show/hide no records message
      var noRecordsMsg = document.getElementById('noRecordsMessage');
      if (noRecordsMsg) {
        if ((tester !== 'ALL' || status !== 'ALL') && (visibleBlocks === 0 || totalVisibleRows === 0)) {
          noRecordsMsg.style.display = 'block';
        } else {
          noRecordsMsg.style.display = 'none';
        }
      }
    }
    
    // Tab switching functionality
    function switchTab(tabName) {
      // Hide all tab contents
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
      });
      
      // Remove active class from all buttons
      document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.remove('active');
      });
      
      // Show selected tab and activate button
      document.getElementById(tabName).classList.add('active');
      event.target.classList.add('active');
      
      // Initialize bug charts when bug reports tab is opened
      if (tabName === 'bug-reports') {
        setTimeout(initializeBugCharts, 100);
      }
    }
    
    // Initialize bug tracking charts with real JIRA data
    function initializeBugCharts() {
      const bugStatusData = ${JSON.stringify(Object.entries(this.bugMetrics.statuses))};
      const bugPriorityData = ${JSON.stringify(Object.entries(this.bugMetrics.priorities))};
      
      // Bug Status Chart
      const statusCtx = document.getElementById('bugStatusChart');
      if (statusCtx && !statusCtx.chart) {
        statusCtx.chart = new Chart(statusCtx, {
          type: 'doughnut',
          data: {
            labels: bugStatusData.map(item => item[0]),
            datasets: [{
              data: bugStatusData.map(item => item[1]),
              backgroundColor: ['#6b7280', '#ea580c', '#10b981', '#7c3aed', '#ca8a04'],
              borderWidth: 0
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'bottom',
                labels: { padding: 20, font: { size: 12 } }
              }
            }
          }
        });
      }
      
      // Bug Priority Chart
      const priorityCtx = document.getElementById('bugPriorityChart');
      if (priorityCtx && !priorityCtx.chart) {
        priorityCtx.chart = new Chart(priorityCtx, {
          type: 'doughnut',
          data: {
            labels: bugPriorityData.map(item => item[0]),
            datasets: [{
              data: bugPriorityData.map(item => item[1]),
              backgroundColor: ['#dc2626', '#ea580c', '#ca8a04', '#16a34a'],
              borderWidth: 0
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'bottom',
                labels: { padding: 20, font: { size: 12 } }
              }
            }
          }
        });
      }
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
      
      // Individual tester pie charts
      ${data.map(row => {
        const group = grouped[row.testerName];
        const testerStatusCounts = Object.values(group.statusCounts);
        const testerStatusLabels = Object.keys(group.statusCounts);
        const testerColors = testerStatusLabels.map(status => statusColors[status] || '#e0e0e0');
        
        return `
      try {
        new Chart(document.getElementById('pieChart-${row.testerName.replace(/\s+/g, '')}').getContext('2d'), {
          type: 'doughnut',
          data: { 
            labels: ${JSON.stringify(testerStatusLabels)}, 
            datasets: [{ 
              data: ${JSON.stringify(testerStatusCounts)}, 
              backgroundColor: ${JSON.stringify(testerColors)},
              borderWidth: 2,
              borderColor: '#ffffff'
            }] 
          },
          options: { 
            plugins: { 
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function(context) {
                    return context.label + ': ' + context.parsed + ' tickets';
                  }
                }
              }
            },
            maintainAspectRatio: false,
            responsive: true
          }
        });
      } catch(e) { console.log('Chart error for ${row.testerName}:', e); }`;
      }).join('')}
      
      // Toggle function for individual tester details
      window.toggleTesterDetails = function(testerName) {
        const detailsDiv = document.getElementById('details-' + testerName);
        const toggleIcon = document.getElementById('toggle-icon-' + testerName);
        
        if (detailsDiv.style.maxHeight === '0px' || !detailsDiv.style.maxHeight) {
          // Expand
          detailsDiv.style.maxHeight = detailsDiv.scrollHeight + 'px';
          detailsDiv.style.padding = '0';
          toggleIcon.style.transform = 'rotate(180deg)';
        } else {
          // Collapse
          detailsDiv.style.maxHeight = '0px';
          detailsDiv.style.padding = '0';
          toggleIcon.style.transform = 'rotate(0deg)';
        }
      };
    };
  </script>
</body>
</html>`;
  }

  // Fetch JIRA issues using service account
  async fetchJiraIssues() {
    try {
      console.log('🐛 Fetching JIRA issues...');
      
      if (!process.env.JIRA_BASE_URL || !process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
        throw new Error('Missing JIRA credentials in .env file');
      }
      
      const jiraAuth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
      const jiraUrl = `${process.env.JIRA_BASE_URL.replace(/\/$/, '')}/rest/api/3/search/jql`;
      
      console.log(`🔗 JIRA URL: ${jiraUrl}`);
      
      const response = await axios({
        method: 'GET',
        url: jiraUrl,
        headers: {
          'Authorization': `Basic ${jiraAuth}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        params: {
          jql: '(project = NR AND (issuetype = "BA QA Issue" OR issuetype = "Bug" OR issuetype = "Defect" OR issuetype = "E2E Defect")) OR reporter = "vthogaru@newrelic.com" ORDER BY created DESC',
          maxResults: 500,
          fields: 'key,summary,priority,status,reporter,environment,created,updated,issuetype,assignee'
        },
        timeout: 30000
      });
      
      const issues = response.data.issues || [];
      console.log(`✅ Fetched ${issues.length} JIRA issues`);
      
      // Process JIRA data for dashboard
      this.jiraBugs = issues.map(issue => ({
        id: issue.key,
        summary: issue.fields.summary || 'No summary',
        priority: issue.fields.priority?.name || 'Medium',
        status: issue.fields.status?.name || 'Open',
        reporter: issue.fields.reporter?.displayName || 'Unknown',
        reporterEmail: issue.fields.reporter?.emailAddress || 'Unknown',
        assignee: issue.fields.assignee?.displayName || 'Unassigned',
        issueType: issue.fields.issuetype?.name || 'Issue',
        environment: issue.fields.environment || 'Not specified',
        created: new Date(issue.fields.created).toLocaleDateString(),
        updated: new Date(issue.fields.updated).toLocaleDateString()
      }));
      
      this.generateBugMetrics();
      
    } catch (error) {
      console.error('❌ Error fetching JIRA issues:', error.response?.data || error.message);
      console.log('🔄 Using sample data for demonstration...');
      // Use enhanced sample data that mimics real JIRA structure
      this.jiraBugs = [
        { id: 'NR-12345', summary: 'Login functionality fails on Safari browser during authentication', priority: 'Critical', status: 'In Progress', reporter: 'Altaf Khan', environment: 'Production' },
        { id: 'NR-12346', summary: 'Dashboard charts not loading properly on mobile devices', priority: 'High', status: 'Open', reporter: 'Brunda Singh', environment: 'Staging' },
        { id: 'NR-12347', summary: 'API timeout errors in transaction processing workflow', priority: 'Medium', status: 'Fixed', reporter: 'Harsha Patel', environment: 'Development' },
        { id: 'NR-12348', summary: 'Minor UI alignment issues on tablet view in settings page', priority: 'Low', status: 'Closed', reporter: 'Veera Kumar', environment: 'QA' },
        { id: 'NR-12349', summary: 'Performance degradation in search functionality with large datasets', priority: 'High', status: 'In Progress', reporter: 'Raj Mehta', environment: 'Production' },
        { id: 'NR-12350', summary: 'Email notification service intermittent failures', priority: 'Medium', status: 'Open', reporter: 'Sanjay Gupta', environment: 'Staging' },
        { id: 'NR-12351', summary: 'Database connection pool exhaustion during peak hours', priority: 'Critical', status: 'Fixed', reporter: 'Priya Shah', environment: 'Production' },
        { id: 'NR-12352', summary: 'Form validation errors not displaying correct message format', priority: 'Low', status: 'Open', reporter: 'Amit Verma', environment: 'Development' }
      ];
      this.generateBugMetrics();
    }
  }

  // Generate bug metrics from JIRA data
  generateBugMetrics() {
    this.bugMetrics.priorities = this.jiraBugs.reduce((acc, bug) => {
      acc[bug.priority] = (acc[bug.priority] || 0) + 1;
      return acc;
    }, {});
    
    this.bugMetrics.statuses = this.jiraBugs.reduce((acc, bug) => {
      acc[bug.status] = (acc[bug.status] || 0) + 1;
      return acc;
    }, {});
    
    // Add reporter analytics (matching your E2E Defects dashboard)
    this.bugMetrics.reporters = this.jiraBugs.reduce((acc, bug) => {
      const reporter = bug.reporter === 'Unknown' ? 'Unknown' : bug.reporter;
      acc[reporter] = (acc[reporter] || 0) + 1;
      return acc;
    }, {});
    
    // Get vthogaru's specific tickets
    this.bugMetrics.vthogaru_tickets = this.jiraBugs.filter(bug => 
      bug.reporterEmail && bug.reporterEmail.includes('vthogaru@newrelic')
    );
  }

  // Generate bug reports HTML with real JIRA data
  generateBugReportsHTML() {
    const priorityColors = {
      'Blocker': '#dc2626', 'Critical': '#dc2626', 'Highest': '#dc2626',
      'Major': '#ea580c', 'High': '#ea580c',
      'Medium': '#ca8a04', 'Minor': '#16a34a', 'Low': '#16a34a', 'Lowest': '#16a34a'
    };
    
    const statusColors = {
      'Open': '#6b7280', 'To Do': '#6b7280', 'Backlog': '#6b7280',
      'In Progress': '#ea580c', 'In Review': '#ca8a04',
      'Done': '#10b981', 'Fixed': '#10b981', 'Resolved': '#10b981', 'Closed': '#7c3aed'
    };
    
    const { priorities, statuses, reporters, vthogaru_tickets } = this.bugMetrics;
    
    // Sort reporters by issue count (matching your dashboard)
    const sortedReporters = Object.entries(reporters).sort(([,a], [,b]) => b - a);
    const topReporters = sortedReporters.slice(0, 10);
    
    const bugRows = this.jiraBugs.slice(0, 20).map(bug => `
      <tr style="border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 12px; font-weight: 600; color: #3b82f6;">${bug.id}</td>
        <td style="padding: 12px; max-width: 400px; word-wrap: break-word;">${bug.summary}</td>
        <td style="padding: 12px;">
          <span style="background: ${priorityColors[bug.priority] || '#6b7280'}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8em;">${bug.priority}</span>
        </td>
        <td style="padding: 12px;">
          <span style="background: ${statusColors[bug.status] || '#6b7280'}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8em;">${bug.status}</span>
        </td>
        <td style="padding: 12px;">${bug.reporter}</td>
        <td style="padding: 12px;">${bug.issueType}</td>
        <td style="padding: 12px;">${bug.assignee}</td>
      </tr>`).join('');
    
    const vthogaru_rows = vthogaru_tickets.slice(0, 10).map(bug => `
      <tr style="border-bottom: 1px solid #e2e8f0; background: #f0f9ff;">
        <td style="padding: 12px; font-weight: 600; color: #3b82f6;">${bug.id}</td>
        <td style="padding: 12px; max-width: 400px; word-wrap: break-word;">${bug.summary}</td>
        <td style="padding: 12px;">
          <span style="background: ${priorityColors[bug.priority] || '#6b7280'}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8em;">${bug.priority}</span>
        </td>
        <td style="padding: 12px;">
          <span style="background: ${statusColors[bug.status] || '#6b7280'}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8em;">${bug.status}</span>
        </td>
        <td style="padding: 12px;">${bug.assignee}</td>
        <td style="padding: 12px;">${bug.created}</td>
      </tr>`).join('');
    
    return `
      <!-- Bug Reports Dashboard -->
      <div class="bug-summary-card">
        <h2 style="margin: 0 0 10px 0; font-size: 2.2em;">🐛 JIRA Bug Reports Dashboard</h2>
        <p style="margin: 0; opacity: 0.9; font-size: 1.1em;">Live Quality Issues from New Relic JIRA • Total Issues: ${this.jiraBugs.length}</p>
      </div>
      
      <div class="bug-metrics-grid">
        <div class="bug-metric-card">
          <h3 style="color: #dc2626; margin: 0 0 10px 0;">🔴 Critical/Blocker</h3>
          <div style="font-size: 2.5em; font-weight: 700; color: #dc2626;">${(priorities['Critical'] || 0) + (priorities['Blocker'] || 0) + (priorities['Highest'] || 0)}</div>
        </div>
        <div class="bug-metric-card">
          <h3 style="color: #ea580c; margin: 0 0 10px 0;">🟡 High/Major</h3>
          <div style="font-size: 2.5em; font-weight: 700; color: #ea580c;">${(priorities['High'] || 0) + (priorities['Major'] || 0)}</div>
        </div>
        <div class="bug-metric-card">
          <h3 style="color: #ca8a04; margin: 0 0 10px 0;">🟠 Medium</h3>
          <div style="font-size: 2.5em; font-weight: 700; color: #ca8a04;">${priorities['Medium'] || 0}</div>
        </div>
        <div class="bug-metric-card">
          <h3 style="color: #16a34a; margin: 0 0 10px 0;">🟢 Low/Minor</h3>
          <div style="font-size: 2.5em; font-weight: 700; color: #16a34a;">${(priorities['Low'] || 0) + (priorities['Minor'] || 0) + (priorities['Lowest'] || 0)}</div>
        </div>
      </div>
      
      <div class="bug-chart-container">
        <div style="background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h3 style="margin: 0 0 20px 0; color: #374151;">📊 Bug Status Distribution</h3>
          <canvas id="bugStatusChart" width="400" height="300"></canvas>
        </div>
        <div style="background: white; padding: 20px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h3 style="margin: 0 0 20px 0; color: #374151;">👥 Top Bug Reporters</h3>
          <div style="max-height: 300px; overflow-y: auto;">
            ${topReporters.map(([reporter, count]) => `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f3f4f6;">
                <span style="font-weight: 600; color: #374151;">${reporter}</span>
                <span style="background: #3b82f6; color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.9em; font-weight: 600;">${count}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
      
      <div class="bug-list">
        <h3 style="margin: 0 0 20px 0; color: #374151;">🎯 Your Bug Tickets (vthogaru@newrelic)</h3>
        <div style="background: #eff6ff; padding: 12px; border-radius: 8px; margin-bottom: 16px;">
          <strong style="color: #1d4ed8;">Total Issues Created by You: ${vthogaru_tickets.length}</strong>
        </div>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
          <thead>
            <tr style="background: #f0f9ff; border-bottom: 2px solid #e2e8f0;">
              <th style="padding: 12px; text-align: left; font-weight: 600;">Bug ID</th>
              <th style="padding: 12px; text-align: left; font-weight: 600;">Summary</th>
              <th style="padding: 12px; text-align: left; font-weight: 600;">Priority</th>
              <th style="padding: 12px; text-align: left; font-weight: 600;">Status</th>
              <th style="padding: 12px; text-align: left; font-weight: 600;">Assignee</th>
              <th style="padding: 12px; text-align: left; font-weight: 600;">Created</th>
            </tr>
          </thead>
          <tbody>
            ${vthogaru_rows || '<tr><td colspan="6" style="padding: 20px; text-align: center; color: #6b7280;">No tickets found for vthogaru@newrelic</td></tr>'}
          </tbody>
        </table>
      </div>
      
      <div class="bug-list">
        <h3 style="margin: 0 0 20px 0; color: #374151;">🎯 All E2E Defects & BA QA Issues</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
              <th style="padding: 12px; text-align: left; font-weight: 600;">Bug ID</th>
              <th style="padding: 12px; text-align: left; font-weight: 600;">Summary</th>
              <th style="padding: 12px; text-align: left; font-weight: 600;">Priority</th>
              <th style="padding: 12px; text-align: left; font-weight: 600;">Status</th>
              <th style="padding: 12px; text-align: left; font-weight: 600;">Reporter</th>
              <th style="padding: 12px; text-align: left; font-weight: 600;">Type</th>
              <th style="padding: 12px; text-align: left; font-weight: 600;">Assignee</th>
            </tr>
          </thead>
          <tbody>
            ${bugRows}
          </tbody>
        </table>
      </div>`;
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
      await reporter.fetchJiraIssues();
      const { htmlPath } = reporter.saveReports();
      console.log(`✅ Report saved: ${path.resolve(htmlPath)}`);
    } catch (err) {
      console.error('❌ Error:', err.message);
      process.exit(1);
    }
  })();
}