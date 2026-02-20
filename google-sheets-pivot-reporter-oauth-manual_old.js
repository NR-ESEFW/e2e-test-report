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
    .bug-list {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .clickable-count:hover {
      opacity: 0.8;
      transform: scale(1.05);
    }
    .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      overflow: auto;
      background-color: rgba(0,0,0,0.5);
    }
    .modal-content {
      background-color: #fefefe;
      margin: 5% auto;
      padding: 20px;
      border: none;
      border-radius: 12px;
      width: 90%;
      max-width: 1000px;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    }
    .close {
      color: #aaa;
      float: right;
      font-size: 28px;
      font-weight: bold;
      cursor: pointer;
      line-height: 1;
    }
    .close:hover,
    .close:focus {
      color: #000;
      text-decoration: none;
    }
    .ticket-key {
      font-weight: bold;
      color: #1d4ed8;
      margin-right: 10px;
    }
    .ticket-status {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.8em;
      font-weight: bold;
      margin-left: 10px;
    }
    .service-section {
      transition: all 0.3s ease;
    }
    .service-nav-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    .tester-detailed-card {
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .tester-detailed-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 40px rgba(0,0,0,0.15);
    }
    .enhanced-metric-card {
      background: white;
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.05);
      transition: all 0.2s ease;
      border: 1px solid #e2e8f0;
    }
    .enhanced-metric-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(0,0,0,0.1);
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
          ${process.env.ENABLE_BUG_REPORTS === 'true' ? `
          <button class="tab-button" onclick="switchTab('bug-reports')">
            🐛 Bug Reports Dashboard
          </button>
          <button class="tab-button" onclick="switchTab('regression-reports')">
            🔄 O2C Regression
          </button>
          ` : ''}
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
  
  ${process.env.ENABLE_BUG_REPORTS === 'true' ? `
  <div id="bug-reports" class="tab-content">
    ${this.generateBugReportsHTML()}
  </div>
  <div id="regression-reports" class="tab-content">
    ${this.generateRegressionReportsHTML()}
  </div>
  ` : ''}
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

    // Label filtering functionality
    function filterByLabel(selectedLabel) {
      const rows = document.querySelectorAll('.bug-row');
      const statusHeaders = document.querySelectorAll('.status-header');
      let visibleCount = 0;
      
      // Hide all status headers first
      statusHeaders.forEach(header => {
        header.style.display = 'none';
      });
      
      rows.forEach(row => {
        const labels = row.getAttribute('data-labels');
        if (labels && labels.split(',').includes(selectedLabel)) {
          row.style.display = '';
          visibleCount++;
          // Show the status header for this row
          const statusClass = row.className.match(/status-([\w-]+)/);
          if (statusClass) {
            const statusHeader = document.querySelector('.status-header[onclick*="' + statusClass[1] + '"]');
            if (statusHeader) statusHeader.style.display = '';
          }
        } else {
          row.style.display = 'none';
        }
      });
      
      // Update the table header to show filtered results
      updateTableHeader(selectedLabel, visibleCount);
      
      // Highlight selected label card
      highlightSelectedLabel(selectedLabel);
    }
    
    function showAllTickets() {
      const rows = document.querySelectorAll('.bug-row');
      const statusHeaders = document.querySelectorAll('.status-header');
      
      // Show all status headers
      statusHeaders.forEach(header => {
        header.style.display = '';
      });
      
      // Show only tickets in expanded status groups
      rows.forEach(row => {
        const statusClass = row.className.match(/status-([\w-]+)/);
        if (statusClass) {
          const statusName = statusClass[1];
          const toggle = document.getElementById('toggle-' + statusName);
          if (toggle && toggle.textContent === '▼') {
            row.style.display = '';
          } else {
            row.style.display = 'none';
          }
        }
      });
      
      // Reset table header
      updateTableHeader('All', rows.length);
      
      // Remove highlight from label cards
      highlightSelectedLabel(null);
    }

    // Status group toggle functionality
    function toggleStatusGroup(statusName) {
      const rows = document.querySelectorAll('.status-' + statusName);
      const toggle = document.getElementById('toggle-' + statusName);
      const isExpanded = toggle.textContent === '▼';
      
      rows.forEach(row => {
        row.style.display = isExpanded ? 'none' : '';
      });
      
      toggle.textContent = isExpanded ? '▶' : '▼';
    }
    
    function updateTableHeader(filterType, count) {
      const header = document.querySelector('.bug-list h3');
      if (header) {
        if (filterType === 'All') {
          const totalTickets = document.querySelectorAll('.bug-row').length;
          header.innerHTML = '🎯 All BA QA Issues <span style="font-size: 0.8em; color: #6b7280;">(' + totalTickets + ' total tickets • Grouped by status • Click to expand/collapse • Click label above to filter)</span>';
        } else {
          header.innerHTML = '🏷️ Tickets with Label: <span style="background: #6366f1; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8em;">' + filterType + '</span> <span style="font-size: 0.8em; color: #6b7280;">(' + count + ' tickets found)</span>';
        }
      }
    }
    
    function highlightSelectedLabel(selectedLabel) {
      const labelCards = document.querySelectorAll('.label-filter-card');
      labelCards.forEach(card => {
        if (selectedLabel && card.textContent.includes(selectedLabel)) {
          card.style.background = '#6366f1';
          card.style.color = 'white';
          const h3 = card.querySelector('h3');
          if (h3) h3.style.color = 'white';
          const count = card.querySelector('div[style*="font-size: 2em"]');
          if (count) count.style.color = 'white';
        } else if (selectedLabel === null && card.textContent.includes('All Tickets')) {
          card.style.background = '#374151';
          card.style.color = 'white';
          const h3 = card.querySelector('h3');
          if (h3) h3.style.color = 'white';
          const count = card.querySelector('div[style*="font-size: 2em"]');
          if (count) count.style.color = 'white';
        } else {
          // Reset to original styles
          if (card.textContent.includes('All Tickets')) {
            card.style.background = '#f8fafc';
            card.style.color = '';
            const h3 = card.querySelector('h3');
            if (h3) h3.style.color = '#374151';
            const count = card.querySelector('div[style*="font-size: 2em"]');
            if (count) count.style.color = '#374151';
          } else {
            card.style.background = 'white';
            card.style.color = '';
            const h3 = card.querySelector('h3');
            if (h3) h3.style.color = '#6366f1';
            const count = card.querySelector('div[style*="font-size: 2em"]');
            if (count) count.style.color = '#6366f1';
          }
        }
      });
    }
  </script>

  <!-- Modal for Ticket Details -->
  <div id="ticketModal" class="modal">
    <div class="modal-content">
      <span class="close" onclick="closeModal()">&times;</span>
      <h2 id="modalTitle">Ticket Details</h2>
      <div id="modalContent">Loading...</div>
    </div>
  </div>

  <script>
    // Store enhanced JIRA tickets data for detailed modal access
    window.enhancedAssigneeData = ${JSON.stringify(this.enhancedAssigneeStats)};
    window.enhancedReporterData = ${JSON.stringify(this.enhancedReporterStats)};
    window.jiraTicketsData = ${JSON.stringify(this.jiraRawData)};
    
    // Enhanced service navigation function
    function showService(serviceId) {
      document.querySelectorAll('.service-section').forEach(section => {
        section.style.display = 'none';
      });
      document.querySelectorAll('.service-nav-btn').forEach(btn => {
        btn.style.background = btn.textContent.includes('Assignee') ? 'linear-gradient(135deg, #8b5cf6, #7c3aed)' :
                             btn.textContent.includes('Reporter') ? 'linear-gradient(135deg, #059669, #047857)' :
                             'linear-gradient(135deg, #374151, #1f2937)';
      });
      const selectedSection = document.getElementById(serviceId);
      if (selectedSection) {
        selectedSection.style.display = 'block';
        event.target.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
      }
    }
    
    // Enhanced ticket details function
    function showDetailedTickets(testerName, status, type) {
      const modal = document.getElementById('ticketModal');
      const modalTitle = document.getElementById('modalTitle');
      const modalContent = document.getElementById('modalContent');
      
      const roleText = type === 'assigned' ? 'Assigned to' : 'Reported by';
      modalTitle.textContent = roleText + ' ' + testerName + ' - ' + status + ' Status Details';
      
      const enhancedData = type === 'assigned' ? window.enhancedAssigneeData : window.enhancedReporterData;
      const testerData = enhancedData[testerName];
      
      if (!testerData || !testerData.tickets) {
        modalContent.innerHTML = '<p>No detailed data found for this tester.</p>';
        modal.style.display = 'block';
        return;
      }
      
      let filteredTickets = testerData.tickets;
      if (status !== 'ALL') {
        filteredTickets = testerData.tickets.filter(ticket => ticket.statusCategory === status);
      }
      
      if (filteredTickets.length === 0) {
        modalContent.innerHTML = '<p>No tickets found for this criteria.</p>';
      } else {
        let ticketHTML = '<div style="margin-bottom: 20px;"><div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 20px;">';
        
        ticketHTML += '<div style="background: #f8fafc; padding: 15px; border-radius: 8px; text-align: center;"><div style="font-size: 1.5em; font-weight: 700; color: #374151;">' + filteredTickets.length + '</div><div style="font-size: 0.9em; color: #6b7280;">Total Tickets</div></div>';
        
        const criticalCount = filteredTickets.filter(t => ['Critical', 'Blocker', 'Highest'].includes(t.priority)).length;
        ticketHTML += '<div style="background: #dcfce7; padding: 15px; border-radius: 8px; text-align: center;"><div style="font-size: 1.5em; font-weight: 700; color: #16a34a;">' + criticalCount + '</div><div style="font-size: 0.9em; color: #16a34a;">Critical</div></div>';
        
        const highCount = filteredTickets.filter(t => ['High', 'Major'].includes(t.priority)).length;
        ticketHTML += '<div style="background: #fef3c7; padding: 15px; border-radius: 8px; text-align: center;"><div style="font-size: 1.5em; font-weight: 700; color: #d97706;">' + highCount + '</div><div style="font-size: 0.9em; color: #d97706;">High</div></div>';
        
        const labelCount = filteredTickets.filter(t => t.labels && t.labels.length > 0).length;
        ticketHTML += '<div style="background: #e0e7ff; padding: 15px; border-radius: 8px; text-align: center;"><div style="font-size: 1.5em; font-weight: 700; color: #6366f1;">' + labelCount + '</div><div style="font-size: 0.9em; color: #6366f1;">With Labels</div></div>';
        
        ticketHTML += '</div></div>';
        
        filteredTickets.forEach(ticket => {
          const priorityColor = ['Critical', 'Blocker', 'Highest'].includes(ticket.priority) ? '#dc2626' :
                               ['High', 'Major'].includes(ticket.priority) ? '#ea580c' :
                               ticket.priority === 'Medium' ? '#ca8a04' : '#16a34a';
          
          ticketHTML += '<div class="ticket-item" style="background: #f8fafc; border-left: 4px solid ' + priorityColor + '; margin: 10px 0; padding: 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">';
          ticketHTML += '<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">';
          ticketHTML += '<div><a href="https://new-relic.atlassian.net/browse/' + ticket.id + '" target="_blank" style="font-weight: bold; color: #3b82f6; font-size: 1.1em; text-decoration: none; border-bottom: 1px solid transparent; transition: border-color 0.2s;" onmouseover="this.style.borderBottomColor=\'#3b82f6\'" onmouseout="this.style.borderBottomColor=\'transparent\'">' + ticket.id + ' 🔗</a>';
          ticketHTML += '<span style="background: ' + priorityColor + '; color: white; padding: 3px 8px; border-radius: 4px; font-size: 0.75em; font-weight: bold; margin-left: 10px;">' + ticket.priority + '</span></div>';
          ticketHTML += '<div style="text-align: right;"><div style="font-size: 0.8em; color: #6b7280;">Status</div>';
          ticketHTML += '<div style="background: #e5f3ff; color: #1d4ed8; padding: 4px 8px; border-radius: 6px; font-size: 0.8em; font-weight: 600;">' + ticket.status + '</div></div></div>';
          ticketHTML += '<div style="margin-bottom: 12px;"><strong style="color: #374151; line-height: 1.4;">' + ticket.summary + '</strong></div>';
          
          if (ticket.labels && ticket.labels.length > 0) {
            ticketHTML += '<div style="margin-bottom: 10px;"><div style="font-size: 0.8em; color: #6b7280; margin-bottom: 5px;">Labels:</div><div>';
            ticket.labels.forEach(label => {
              ticketHTML += '<span style="background: #e2e8f0; color: #374151; padding: 2px 6px; border-radius: 3px; font-size: 0.75em; margin-right: 4px; display: inline-block; margin-bottom: 2px;">' + label + '</span>';
            });
            ticketHTML += '</div></div>';
          }
          
          if (type === 'reported' && ticket.assignee) {
            ticketHTML += '<div style="margin-bottom: 10px;"><small style="color: #6b7280;">Assigned to: <strong>' + ticket.assignee + '</strong></small></div>';
          }
          
          ticketHTML += '<div style="display: flex; justify-content: space-between; font-size: 0.8em; color: #6b7280;">';
          ticketHTML += '<span>Created: ' + ticket.created + '</span><span>Updated: ' + ticket.updated + '</span></div></div>';
        });
        
        modalContent.innerHTML = ticketHTML;
      }
      
      modal.style.display = 'block';
    }
    
    function showTicketDetails(testerName, status, type) {
      const modal = document.getElementById('ticketModal');
      const modalTitle = document.getElementById('modalTitle');
      const modalContent = document.getElementById('modalContent');
      
      const roleText = type === 'assigned' ? 'Assigned to' : 'Reported by';
      modalTitle.textContent = roleText + ' ' + testerName + ' - ' + status + ' Tickets';
      
      // Filter tickets based on type (assigned or reported)
      let filteredTickets;
      if (status === 'ALL') {
        filteredTickets = window.jiraTicketsData.filter(ticket => {
          if (!ticket || !ticket.fields) return false;
          const assignee = ticket.fields.assignee && ticket.fields.assignee.displayName ? ticket.fields.assignee.displayName : 'Unassigned';
          const creator = ticket.fields.creator && ticket.fields.creator.displayName ? ticket.fields.creator.displayName : 'Unknown';
          
          // Apply name mapping to raw JIRA data for comparison
          const nameMapping = {
            'Venkata Thota': 'Veeraraghava Thogaru'
          };
          const actualAssignee = nameMapping[assignee] || assignee;
          const actualCreator = nameMapping[creator] || creator;
          
          if (type === 'assigned') {
            // Use the same matching logic as the dashboard counting
            const targetWords = testerName.toLowerCase().split(' ');
            const assigneeWords = actualAssignee.toLowerCase().split(' ');
            
            return targetWords.some(targetWord => 
              targetWord.length > 2 && assigneeWords.some(assigneeWord => 
                assigneeWord.includes(targetWord) || targetWord.includes(assigneeWord)
              )
            );
          } else {
            // For reported tickets - use creator field with name mapping
            const targetWords = testerName.toLowerCase().split(' ');
            const creatorWords = actualCreator.toLowerCase().split(' ');
            
            return targetWords.some(targetWord => 
              targetWord.length > 2 && creatorWords.some(creatorWord => 
                creatorWord.includes(targetWord) || targetWord.includes(creatorWord)
              )
            );
          }
        });
      } else {
        filteredTickets = window.jiraTicketsData.filter(ticket => {
          if (!ticket || !ticket.fields) return false;
          const assignee = ticket.fields.assignee && ticket.fields.assignee.displayName ? ticket.fields.assignee.displayName : 'Unassigned';
          const creator = ticket.fields.creator && ticket.fields.creator.displayName ? ticket.fields.creator.displayName : 'Unknown';
          const ticketStatus = ticket.fields.status && ticket.fields.status.name ? ticket.fields.status.name : 'Unknown';
          
          // Apply name mapping to raw JIRA data for comparison
          const nameMapping = {
            'Venkata Thota': 'Veeraraghava Thogaru'
          };
          const actualAssignee = nameMapping[assignee] || assignee;
          const actualCreator = nameMapping[creator] || creator;
          
          // Check if tester name matches based on type using same logic as dashboard
          let isMatchingTester = false;
          if (type === 'assigned') {
            const targetWords = testerName.toLowerCase().split(' ');
            const assigneeWords = actualAssignee.toLowerCase().split(' ');
            
            isMatchingTester = targetWords.some(targetWord => 
              targetWord.length > 2 && assigneeWords.some(assigneeWord => 
                assigneeWord.includes(targetWord) || targetWord.includes(assigneeWord)
              )
            );
          } else {
            const targetWords = testerName.toLowerCase().split(' ');
            const creatorWords = actualCreator.toLowerCase().split(' ');
            
            isMatchingTester = targetWords.some(targetWord => 
              targetWord.length > 2 && creatorWords.some(creatorWord => 
                creatorWord.includes(targetWord) || targetWord.includes(creatorWord)
              )
            );
          }
          
          if (!isMatchingTester) return false;
          
          // Map status categories to match dashboard logic exactly
          let mappedStatus = '';
          if (ticketStatus === 'To Do' || ticketStatus === 'Backlog') {
            mappedStatus = 'To Do';
          } else if (ticketStatus === 'In Progress' || ticketStatus === 'In Review' || ticketStatus === 'QA') {
            mappedStatus = 'QA';
          } else if (ticketStatus === 'Ready for QA' || ticketStatus === 'Open') {
            mappedStatus = 'Ready for QA';
          } else if (ticketStatus === 'Ready for Release' || ticketStatus === 'Pending Deployment') {
            mappedStatus = 'Ready for Release';
          } else if (ticketStatus === 'Done' || ticketStatus === 'Fixed' || ticketStatus === 'Resolved' || ticketStatus === 'Closed' ||
                     ticketStatus === 'Complete' || ticketStatus === 'Completed' || ticketStatus === 'Finished' ||
                     ticketStatus === 'Released' || ticketStatus === 'Deployed' || ticketStatus.toLowerCase().includes('clos')) {
            mappedStatus = 'Closed';
          } else if (ticketStatus === 'Failed' || ticketStatus === 'Blocked') {
            mappedStatus = 'Test Failed';
          } else {
            mappedStatus = 'Other';
          }
          
          return mappedStatus === status;
        });
      }
      
      if (filteredTickets.length === 0) {
        modalContent.innerHTML = '<p>No tickets found for this criteria.</p>';
      } else {
        // Remove duplicates based on ticket key
        const uniqueTickets = filteredTickets.filter((ticket, index, self) => 
          index === self.findIndex(t => t.key === ticket.key)
        );
        
        console.log('Found ' + filteredTickets.length + ' tickets, ' + uniqueTickets.length + ' unique tickets for ' + testerName + ' (' + status + ', ' + type + ')');
        console.log('Unique ticket keys:', uniqueTickets.map(t => t.key).join(', '));
        
        modalContent.innerHTML = uniqueTickets.map(ticket => {
          if (!ticket || !ticket.fields) return '<div class="ticket-item">Invalid ticket data</div>';
          
          const ticketKey = ticket.key || 'Unknown';
          const summary = ticket.fields.summary || 'No summary';
          const statusName = ticket.fields.status && ticket.fields.status.name ? ticket.fields.status.name : 'Unknown';
          const priority = ticket.fields.priority && ticket.fields.priority.name ? ticket.fields.priority.name : 'None';
          const assignee = ticket.fields.assignee && ticket.fields.assignee.displayName ? ticket.fields.assignee.displayName : 'Unassigned';
          const created = ticket.fields.created ? new Date(ticket.fields.created).toLocaleDateString() : 'Unknown';
          
          return '<div class="ticket-item">' +
            '<span class="ticket-key">' + ticketKey + '</span>' +
            '<strong>' + summary + '</strong>' +
            '<span class="ticket-status" style="background-color: #e5f3ff; color: #1d4ed8;">' + statusName + '</span>' +
            '<br>' +
            '<small>Priority: ' + priority + ' | Assignee: ' + assignee + '</small>' +
            '<br>' +
            '<small>Created: ' + created + '</small>' +
          '</div>';
        }).join('');
      }
      
      modal.style.display = 'block';
    }
    
    function closeModal() {
      document.getElementById('ticketModal').style.display = 'none';
    }
    
    // Close modal when clicking outside of it
    window.onclick = function(event) {
      const modal = document.getElementById('ticketModal');
      if (event.target === modal) {
        modal.style.display = 'none';
      }
    }
  </script>
</body>
</html>`;
  }

  // Fetch JIRA issues using service account with pagination
  async fetchJiraIssues() {
    try {
      console.log('🐛 Fetching JIRA issues...');
      
      if (!process.env.JIRA_BASE_URL || !process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
        throw new Error('Missing JIRA credentials in .env file');
      }
      
      const jiraAuth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
      const jiraUrl = `${process.env.JIRA_BASE_URL.replace(/\/$/, '')}/rest/api/3/search/jql`;
      
      console.log(`🔗 JIRA URL: ${jiraUrl}`);
      
      let allIssues = [];
      let startAt = 0;
      const maxResults = 100; // JIRA's typical max per request
      let isLast = false;
      let issues = [];
      
      do {
        const response = await axios({
          method: 'GET',
          url: jiraUrl,
          headers: {
            'Authorization': `Basic ${jiraAuth}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          params: {
            jql: 'assignee IN (712020:aaeb1218-5964-4a80-845e-9cb314f6f232, 712020:fcda8681-af32-4156-bc95-320347316dc3, 712020:3c8b3a4e-afcc-4e9c-8ec7-0090eb1ddb60, 712020:e61ac3c9-73c5-4f39-a30d-11a5ab0c68fc, 712020:bf4d1ab0-b6d6-47a2-bc1c-58178d04421d, 712020:5590d4ea-153b-4a91-8bbf-ae3c410e9612, 557058:7c2a964a-d726-4960-906c-dbd60f1e0c4e) AND type = "BA QA Issue" AND labels = e2e_o2c_bugs ORDER BY created DESC',
            startAt: startAt,
            maxResults: maxResults,
            fields: 'key,summary,priority,status,reporter,assignee,created,updated,labels'
          },
          timeout: 30000
        });
        
        issues = response.data.issues || [];
        isLast = response.data.isLast !== false; // Default to true if not provided
        allIssues = allIssues.concat(issues);
        startAt += maxResults;
        
        console.log(`📥 Fetched ${issues.length} issues (${allIssues.length} total so far) - ${isLast ? 'Last page' : 'More pages available'}`);
        
        // Debug: log response data on first call
        if (startAt === maxResults) {
          console.log(`🔍 Debug - Response keys: ${Object.keys(response.data).join(', ')}`);
          console.log(`🔍 Debug - isLast: ${response.data.isLast}, nextPageToken: ${response.data.nextPageToken || 'none'}`);
        }
        
        // Safety break to avoid infinite loops - increased to 20000 to ensure we get 4000+ unique issues
        if (allIssues.length >= 20000) {
          console.log('⚠️ Reached safety limit of 20000 issues');
          break;
        }
        
      } while (!isLast && issues.length === maxResults);
      
      console.log(`✅ Fetched ${allIssues.length} JIRA issues total`);
      
      // Enhanced deduplication with detailed feedback
      console.log(`🔍 Before deduplication: ${allIssues.length} total issues`);
      
      // Create a Set to track seen keys for efficient deduplication
      const seenKeys = new Set();
      const duplicateKeys = new Set();
      
      const uniqueIssues = allIssues.filter((issue, index) => {
        if (!issue || !issue.key) {
          console.log(`⚠️ Issue at index ${index} has no key, skipping`);
          return false;
        }
        
        if (seenKeys.has(issue.key)) {
          duplicateKeys.add(issue.key);
          return false; // Skip duplicate
        }
        
        seenKeys.add(issue.key);
        return true;
      });
      
      console.log(`🔍 After deduplication: ${uniqueIssues.length} unique issues`);
      if (duplicateKeys.size > 0) {
        console.log(`🗑️ Removed ${allIssues.length - uniqueIssues.length} duplicate tickets`);
        console.log(`📋 Duplicate keys found: ${Math.min(5, duplicateKeys.size)} examples:`, 
          Array.from(duplicateKeys).slice(0, 5).join(', '));
      }
      
      // Limit to 4000 unique issues as requested
      const limitedIssues = uniqueIssues.slice(0, 4000);
      if (uniqueIssues.length > 4000) {
        console.log(`📊 Limited processing to first 4000 unique issues (found ${uniqueIssues.length} total)`);
      }
      
      // Process JIRA data for dashboard - simplified structure
      this.jiraBugs = limitedIssues.map(issue => ({
        id: issue.key,
        summary: issue.fields.summary || 'No summary',
        priority: issue.fields.priority?.name || 'Medium',
        status: issue.fields.status?.name || 'Open',
        reporter: issue.fields.creator?.displayName || issue.fields.reporter?.displayName || 'Unknown',
        reporterEmail: issue.fields.creator?.emailAddress || '',
        assignee: issue.fields.assignee?.displayName || 'Unassigned',
        assigneeEmail: issue.fields.assignee?.emailAddress || '',
        labels: issue.fields.labels || [],
        created: new Date(issue.fields.created).toLocaleDateString(),
        updated: new Date(issue.fields.updated).toLocaleDateString()
      }));
      
      // Store full JIRA data for modal - keep the original API structure (limited to 4000)
      this.jiraRawData = limitedIssues;
      
      // Filter Veeraraghava Thogaru's tickets (assigned or reported)
      const vthogaru_tickets = this.jiraBugs.filter(bug => 
        (bug.reporterEmail && bug.reporterEmail.includes('vthoharu@newrelic.com')) ||
        (bug.assigneeEmail && bug.assigneeEmail.includes('vthoharu@newrelic.com')) ||
        bug.reporter === 'Veeraraghava Thogaru' ||
        bug.assignee === 'Veeraraghava Thogaru'
      );
      
      console.log(`🎯 Found ${vthogaru_tickets.length} tickets for Veeraraghava Thogaru`);
      
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
  }

  // Generate enhanced bug reports HTML with enhanced assignee/reporter service
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

    // Count labels across all bugs
    const labelCounts = {};
    this.jiraBugs.forEach(bug => {
      if (bug.labels && bug.labels.length > 0) {
        bug.labels.forEach(label => {
          labelCounts[label] = (labelCounts[label] || 0) + 1;
        });
      }
    });

    const { priorities, statuses } = this.bugMetrics;
    
    // Create Testers Dashboard - Group by reporter/assignee with status counts
    const targetTesters = [
      'Gary Bermudez Mora',
      'Latheesh Parisineti', 
      'Harshavardhan Reddy',
      'Veeraraghava Thogaru',  // vthogaru@newrelic.com (might show as "Venkata Thota" in JIRA)
      'Rama Chavali',
      'Venkata Thota',         // vthota@newrelic.com 
      'Pushpa Belvatta'
    ];
    
    // Name mapping to handle JIRA display name inconsistencies
    const nameMapping = {
      'Venkata Thota': 'Veeraraghava Thogaru'  // Map JIRA display name to actual person
    };
    
    // Enhanced Assignee/Reporter Service - Add performance metrics and detailed tracking
    this.enhancedAssigneeStats = {};
    this.enhancedReporterStats = {};
    
    // Initialize regression stats as class properties
    this.regressionAssignedStats = {};
    this.regressionReportedStats = {};
    
    targetTesters.forEach(tester => {
      this.enhancedAssigneeStats[tester] = {
        statusCounts: {
          'To Do': 0, 'QA': 0, 'Ready for QA': 0, 'Ready for Release': 0, 'Closed': 0, 'Test Failed': 0, 'Other': 0, 'Total': 0
        },
        tickets: [], // Individual ticket details
        performance: {
          avgResolutionTime: 0,
          completionRate: 0,
          criticalBugsFixed: 0,
          bugTrend: 'stable' // 'improving', 'stable', 'declining'
        },
        labels: {},
        priorities: {},
        recentActivity: []
      };
      
      this.enhancedReporterStats[tester] = {
        statusCounts: {
          'To Do': 0, 'QA': 0, 'Ready for QA': 0, 'Ready for Release': 0, 'Closed': 0, 'Test Failed': 0, 'Other': 0, 'Total': 0
        },
        tickets: [], // Individual ticket details
        performance: {
          qualityScore: 0, // Based on bug severity and accuracy
          reportingAccuracy: 0,
          duplicateRate: 0,
          reportTrend: 'stable'
        },
        labels: {},
        priorities: {},
        recentActivity: []
      };
      
      // Initialize regression stats
      this.regressionAssignedStats[tester] = {
        'To Do': 0, 'QA': 0, 'Ready for QA': 0, 'Ready for Release': 0, 
        'Closed': 0, 'Test Failed': 0, 'Other': 0, 'Total': 0
      };
      
      this.regressionReportedStats[tester] = {
        'To Do': 0, 'QA': 0, 'Ready for QA': 0, 'Ready for Release': 0, 
        'Closed': 0, 'Test Failed': 0, 'Other': 0, 'Total': 0
      };
    });
    
    // Track processed tickets to avoid duplicates
    const processedTickets = new Set();
    const allStatuses = new Set();
    const closedStatuses = new Set();
    
    this.jiraBugs.forEach(bug => {
      // Skip if we've already processed this ticket ID
      if (processedTickets.has(bug.id)) {
        return;
      }
      processedTickets.add(bug.id);
      
      const assigneeName = bug.assignee || 'Unassigned';
      const reporterName = bug.reporter || 'Unknown';
      const status = bug.status;
      const labels = bug.labels || [];
      
      // Apply name mapping to handle JIRA display name inconsistencies
      const actualAssigneeName = nameMapping[assigneeName] || assigneeName;
      const actualReporterName = nameMapping[reporterName] || reporterName;
      
      // Debug logging for names starting with V to help find Veeraraghava
      if (assigneeName.toLowerCase().includes('v') || reporterName.toLowerCase().includes('v')) {
        console.log(`🔍 Debug name: Assignee="${assigneeName}" → "${actualAssigneeName}", Reporter="${reporterName}" → "${actualReporterName}"`);
      }
      
      // Collect all statuses for debugging
      allStatuses.add(status);
      
      // Debug labels for e2e testing tickets
      if (labels.length > 0 && (labels.some(label => label.toLowerCase().includes('e2e') || label.toLowerCase().includes('o2c')))) {
        console.log('🏷️ E2E/O2C TICKET: ' + bug.id + ' - Assignee: ' + assigneeName + ' - Labels: ' + labels.join(', ') + ' - Status: ' + status);
      }
      
      // Check if ticket is specifically o2c_regression
      const isRegressionTicket = labels.some(label => 
        label.toLowerCase().includes('o2c_regression')
      );
      
      if (isRegressionTicket) {
        console.log('🔄 REGRESSION TICKET: ' + bug.id + ' - Assignee: ' + assigneeName + ' - Labels: ' + labels.join(', ') + ' - Status: ' + status);
      }
      
      // Track closed-like statuses
      if (status && (status.toLowerCase().includes('clos') || 
          status.toLowerCase().includes('done') || 
          status.toLowerCase().includes('resolv') || 
          status.toLowerCase().includes('fix') ||
          status.toLowerCase().includes('complet'))) {
        closedStatuses.add(status);
      }
      
      console.log('Processing ticket ' + bug.id + ': Assignee=' + assigneeName + ', Reporter=' + reporterName + ', Status=' + status);
      
      // Special debugging for Veeraraghava tickets
      if (assigneeName.includes('Veeraraghava') || assigneeName.includes('Thogaru')) {
        console.log('🔍 VEERARAGHAVA ASSIGNED TICKET: ' + bug.id + ' - Status: ' + status + ' - Assignee: ' + assigneeName);
      }
      if (reporterName.includes('Veeraraghava') || reporterName.includes('Thogaru')) {
        console.log('📝 VEERARAGHAVA REPORTED TICKET: ' + bug.id + ' - Status: ' + status + ' - Reporter: ' + reporterName);
      }
      
      // Find matches for assignee with improved logic
      const matchedAssignee = targetTesters.find(target => {
        // Split names for better matching
        const targetWords = target.toLowerCase().split(' ');
        const assigneeWords = actualAssigneeName.toLowerCase().split(' ');
        
        // Check if any significant word matches (length > 2 to avoid short matches)
        return targetWords.some(targetWord => 
          targetWord.length > 2 && assigneeWords.some(assigneeWord => 
            assigneeWord.includes(targetWord) || targetWord.includes(assigneeWord)
          )
        );
      });
      
      // Find matches for reporter with improved logic
      const matchedReporter = targetTesters.find(target => {
        const targetWords = target.toLowerCase().split(' ');
        const reporterWords = actualReporterName.toLowerCase().split(' ');
        
        return targetWords.some(targetWord => 
          targetWord.length > 2 && reporterWords.some(reporterWord => 
            reporterWord.includes(targetWord) || targetWord.includes(reporterWord)
          )
        );
      });
      
      if (matchedAssignee) {
        console.log('✅ Matched assignee: ' + actualAssigneeName + ' → ' + matchedAssignee);
      }
      if (matchedReporter) {
        console.log('✅ Matched reporter: ' + actualReporterName + ' → ' + matchedReporter);
      }
      
      // Enhanced tracking for assignee
      if (matchedAssignee) {
        let statusCategory = 'Other';
        if (status === 'To Do' || status === 'Backlog') {
          statusCategory = 'To Do';
          this.enhancedAssigneeStats[matchedAssignee].statusCounts['To Do']++;
        } else if (status === 'In Progress' || status === 'In Review' || status === 'QA') {
          statusCategory = 'QA';
          this.enhancedAssigneeStats[matchedAssignee].statusCounts['QA']++;
        } else if (status === 'Ready for QA' || status === 'Open') {
          statusCategory = 'Ready for QA';
          this.enhancedAssigneeStats[matchedAssignee].statusCounts['Ready for QA']++;
        } else if (status === 'Ready for Release' || status === 'Pending Deployment') {
          statusCategory = 'Ready for Release';
          this.enhancedAssigneeStats[matchedAssignee].statusCounts['Ready for Release']++;
        } else if (status === 'Done' || status === 'Fixed' || status === 'Resolved' || status === 'Closed' || 
                   status === 'Complete' || status === 'Completed' || status === 'Finished' || 
                   status === 'Released' || status === 'Deployed' || status.toLowerCase().includes('clos')) {
          statusCategory = 'Closed';
          this.enhancedAssigneeStats[matchedAssignee].statusCounts['Closed']++;
          console.log(`📋 Added CLOSED ticket ${bug.id} for ${matchedAssignee} (status: ${status})`);
          
          // Track critical bugs fixed
          if (['Critical', 'Blocker', 'Highest'].includes(bug.priority)) {
            this.enhancedAssigneeStats[matchedAssignee].performance.criticalBugsFixed++;
          }
        } else if (status === 'Failed' || status === 'Blocked') {
          statusCategory = 'Test Failed';
          this.enhancedAssigneeStats[matchedAssignee].statusCounts['Test Failed']++;
        } else {
          this.enhancedAssigneeStats[matchedAssignee].statusCounts['Other']++;
        }
        
        this.enhancedAssigneeStats[matchedAssignee].statusCounts['Total']++;
        
        // Store individual ticket details
        this.enhancedAssigneeStats[matchedAssignee].tickets.push({
          id: bug.id,
          summary: bug.summary,
          priority: bug.priority,
          status: status,
          statusCategory: statusCategory,
          labels: labels,
          created: bug.created,
          updated: bug.updated
        });
        
        // Track labels and priorities
        labels.forEach(label => {
          this.enhancedAssigneeStats[matchedAssignee].labels[label] = (this.enhancedAssigneeStats[matchedAssignee].labels[label] || 0) + 1;
        });
        this.enhancedAssigneeStats[matchedAssignee].priorities[bug.priority] = (this.enhancedAssigneeStats[matchedAssignee].priorities[bug.priority] || 0) + 1;
        
        // Calculate completion rate
        const totalClosed = this.enhancedAssigneeStats[matchedAssignee].statusCounts['Closed'];
        const totalTickets = this.enhancedAssigneeStats[matchedAssignee].statusCounts['Total'];
        this.enhancedAssigneeStats[matchedAssignee].performance.completionRate = 
          totalTickets > 0 ? Math.round((totalClosed / totalTickets) * 100) : 0;
        
        // Add to recent activity
        this.enhancedAssigneeStats[matchedAssignee].recentActivity.push({
          ticketId: bug.id,
          action: `Assigned ${status}`,
          date: bug.updated || bug.created,
          priority: bug.priority
        });
        
        // Track regression tickets
        if (isRegressionTicket) {
          // Ensure regression stats exist for this tester
          if (!this.regressionAssignedStats[matchedAssignee]) {
            this.regressionAssignedStats[matchedAssignee] = {
              'To Do': 0, 'QA': 0, 'Ready for QA': 0, 'Ready for Release': 0, 
              'Closed': 0, 'Test Failed': 0, 'Other': 0, 'Total': 0
            };
          }
          
          if (status === 'To Do' || status === 'Backlog') {
            this.regressionAssignedStats[matchedAssignee]['To Do']++;
          } else if (status === 'In Progress' || status === 'In Review' || status === 'QA') {
            this.regressionAssignedStats[matchedAssignee]['QA']++;
          } else if (status === 'Ready for QA' || status === 'Open') {
            this.regressionAssignedStats[matchedAssignee]['Ready for QA']++;
          } else if (status === 'Ready for Release' || status === 'Pending Deployment') {
            this.regressionAssignedStats[matchedAssignee]['Ready for Release']++;
          } else if (status === 'Done' || status === 'Fixed' || status === 'Resolved' || status === 'Closed' || 
                     status === 'Complete' || status === 'Completed' || status === 'Finished' || 
                     status === 'Released' || status === 'Deployed' || status.toLowerCase().includes('clos')) {
            this.regressionAssignedStats[matchedAssignee]['Closed']++;
          } else if (status === 'Failed' || status === 'Blocked') {
            this.regressionAssignedStats[matchedAssignee]['Test Failed']++;
          } else {
            this.regressionAssignedStats[matchedAssignee]['Other']++;
          }
          this.regressionAssignedStats[matchedAssignee]['Total']++;
          console.log(`🔄 Added REGRESSION ASSIGNED ticket ${bug.id} for ${matchedAssignee} (status: ${status})`);
        }
      }
      
      // Enhanced tracking for reporter
      if (matchedReporter) {
        let statusCategory = 'Other';
        if (status === 'To Do' || status === 'Backlog') {
          statusCategory = 'To Do';
          this.enhancedReporterStats[matchedReporter].statusCounts['To Do']++;
        } else if (status === 'In Progress' || status === 'In Review' || status === 'QA') {
          statusCategory = 'QA';
          this.enhancedReporterStats[matchedReporter].statusCounts['QA']++;
        } else if (status === 'Ready for QA' || status === 'Open') {
          statusCategory = 'Ready for QA';
          this.enhancedReporterStats[matchedReporter].statusCounts['Ready for QA']++;
        } else if (status === 'Ready for Release' || status === 'Pending Deployment') {
          statusCategory = 'Ready for Release';
          this.enhancedReporterStats[matchedReporter].statusCounts['Ready for Release']++;
        } else if (status === 'Done' || status === 'Fixed' || status === 'Resolved' || status === 'Closed' || 
                   status === 'Complete' || status === 'Completed' || status === 'Finished' || 
                   status === 'Released' || status === 'Deployed' || status.toLowerCase().includes('clos')) {
          statusCategory = 'Closed';
          this.enhancedReporterStats[matchedReporter].statusCounts['Closed']++;
          console.log(`📋 Added CLOSED ticket ${bug.id} for ${matchedReporter} (status: ${status})`);
        } else if (status === 'Failed' || status === 'Blocked') {
          statusCategory = 'Test Failed';
          this.enhancedReporterStats[matchedReporter].statusCounts['Test Failed']++;
        } else {
          this.enhancedReporterStats[matchedReporter].statusCounts['Other']++;
        }
        
        this.enhancedReporterStats[matchedReporter].statusCounts['Total']++;
        
        // Store individual ticket details
        this.enhancedReporterStats[matchedReporter].tickets.push({
          id: bug.id,
          summary: bug.summary,
          priority: bug.priority,
          status: status,
          statusCategory: statusCategory,
          assignee: actualAssigneeName,
          labels: labels,
          created: bug.created,
          updated: bug.updated
        });
        
        // Track labels and priorities
        labels.forEach(label => {
          this.enhancedReporterStats[matchedReporter].labels[label] = (this.enhancedReporterStats[matchedReporter].labels[label] || 0) + 1;
        });
        this.enhancedReporterStats[matchedReporter].priorities[bug.priority] = (this.enhancedReporterStats[matchedReporter].priorities[bug.priority] || 0) + 1;
        
        // Calculate quality score based on priority distribution
        const criticalCount = ['Critical', 'Blocker', 'Highest'].reduce((sum, p) => sum + (this.enhancedReporterStats[matchedReporter].priorities[p] || 0), 0);
        const totalReported = this.enhancedReporterStats[matchedReporter].statusCounts['Total'];
        this.enhancedReporterStats[matchedReporter].performance.qualityScore = 
          totalReported > 0 ? Math.max(10, 100 - Math.round((criticalCount / totalReported) * 50)) : 100;
        
        // Add to recent activity
        this.enhancedReporterStats[matchedReporter].recentActivity.push({
          ticketId: bug.id,
          action: `Reported ${status}`,
          date: bug.updated || bug.created,
          priority: bug.priority
        });
        
        // Track regression reported tickets
        if (isRegressionTicket) {
          if (!this.regressionReportedStats[matchedReporter]) {
            this.regressionReportedStats[matchedReporter] = {
              'To Do': 0, 'QA': 0, 'Ready for QA': 0, 'Ready for Release': 0, 
              'Closed': 0, 'Test Failed': 0, 'Other': 0, 'Total': 0
            };
          }
          
          if (status === 'To Do' || status === 'Backlog') {
            this.regressionReportedStats[matchedReporter]['To Do']++;
          } else if (status === 'In Progress' || status === 'In Review' || status === 'QA') {
            this.regressionReportedStats[matchedReporter]['QA']++;
          } else if (status === 'Ready for QA' || status === 'Open') {
            this.regressionReportedStats[matchedReporter]['Ready for QA']++;
          } else if (status === 'Ready for Release' || status === 'Pending Deployment') {
            this.regressionReportedStats[matchedReporter]['Ready for Release']++;
          } else if (status === 'Done' || status === 'Fixed' || status === 'Resolved' || status === 'Closed' || 
                     status === 'Complete' || status === 'Completed' || status === 'Finished' || 
                     status === 'Released' || status === 'Deployed' || status.toLowerCase().includes('clos')) {
            this.regressionReportedStats[matchedReporter]['Closed']++;
          } else if (status === 'Failed' || status === 'Blocked') {
            this.regressionReportedStats[matchedReporter]['Test Failed']++;
          } else {
            this.regressionReportedStats[matchedReporter]['Other']++;
          }
          this.regressionReportedStats[matchedReporter]['Total']++;
          console.log(`🔄 Added REGRESSION REPORTED ticket ${bug.id} for ${matchedReporter} (status: ${status})`);
        }
      }
    });
    
    // Debug: Show all discovered statuses
    console.log('\n🔍 All Status Analysis:');
    console.log('📊 All statuses found:', Array.from(allStatuses).sort());
    console.log('✅ Closed-like statuses found:', Array.from(closedStatuses).sort());
    console.log('📈 Total tickets processed:', processedTickets.size);
    
    // Clean up recent activity (keep only last 10 items)
    Object.values(this.enhancedAssigneeStats).forEach(stats => {
      stats.recentActivity = stats.recentActivity
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 10);
    });
    
    Object.values(this.enhancedReporterStats).forEach(stats => {
      stats.recentActivity = stats.recentActivity
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 10);
    });
    
    // Debug: Print final enhanced stats
    console.log('\n📊 Final Enhanced Assigned Stats:');
    Object.entries(this.enhancedAssigneeStats).forEach(([name, stats]) => {
      if (stats.statusCounts.Total > 0) {
        console.log(`${name}: Total=${stats.statusCounts.Total}, Completion Rate=${stats.performance.completionRate}%, Critical Bugs Fixed=${stats.performance.criticalBugsFixed}`);
      }
    });
    
    console.log('\n📝 Final Enhanced Reported Stats:');
    Object.entries(this.enhancedReporterStats).forEach(([name, stats]) => {
      if (stats.statusCounts.Total > 0) {
        console.log(`${name}: Total=${stats.statusCounts.Total}, Quality Score=${stats.performance.qualityScore}`);
      }
    });

    // Generate Enhanced Assignee Dashboard with detailed information
    const generateTesterCard = (testerName, stats, type) => {
      const escapedName = testerName.replace(/'/g, "\\'");
      const statusCounts = stats.statusCounts;
      const tickets = stats.tickets || [];
      const performance = stats.performance || {};
      const labels = Object.entries(stats.labels || {}).sort((a, b) => b[1] - a[1]);
      const priorities = Object.entries(stats.priorities || {}).sort((a, b) => b[1] - a[1]);
      const recentActivity = stats.recentActivity || [];
      
      const cardColor = type === 'assigned' ? '#8b5cf6' : '#059669';
      const roleText = type === 'assigned' ? 'ASSIGNEE' : 'REPORTER';
      
      return `
        <div class="tester-detailed-card" style="
          background: white;
          border-radius: 16px;
          padding: 25px;
          margin: 20px 0;
          box-shadow: 0 8px 32px rgba(0,0,0,0.1);
          border: 1px solid #e2e8f0;
        ">
          <!-- Tester Header -->
          <div style="
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 25px;
            padding-bottom: 15px;
            border-bottom: 2px solid #f1f5f9;
          ">
            <div style="display: flex; align-items: center; gap: 15px;">
              <div style="
                width: 60px;
                height: 60px;
                border-radius: 50%;
                background: linear-gradient(135deg, ${cardColor}, ${cardColor}aa);
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 24px;
                font-weight: 700;
                color: white;
                text-shadow: 0 2px 4px rgba(0,0,0,0.2);
              ">${testerName.split(' ').map(n => n[0]).join('')}</div>
              <div>
                <h3 style="margin: 0; color: #1f2937; font-size: 1.5em; font-weight: 700;">${testerName}</h3>
                <span style="
                  background: ${cardColor};
                  color: white;
                  padding: 4px 12px;
                  border-radius: 20px;
                  font-size: 0.75em;
                  font-weight: 600;
                  text-transform: uppercase;
                ">${roleText}</span>
              </div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 2.5em; font-weight: 800; color: ${cardColor};">${statusCounts.Total || 0}</div>
              <div style="font-size: 0.9em; color: #6b7280; font-weight: 600;">Total Tickets</div>
            </div>
          </div>
          
          <!-- Performance Metrics -->
          <div style="
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin-bottom: 25px;
          ">
            <div style="
              background: linear-gradient(135deg, #10b981, #059669);
              color: white;
              padding: 15px;
              border-radius: 12px;
              text-align: center;
            ">
              <div style="font-size: 1.8em; font-weight: 700;">${performance.completionRate || performance.qualityScore || 0}${type === 'assigned' ? '%' : ''}</div>
              <div style="font-size: 0.8em; opacity: 0.9;">${type === 'assigned' ? 'Completion Rate' : 'Quality Score'}</div>
            </div>
            
            <div style="
              background: linear-gradient(135deg, #f59e0b, #d97706);
              color: white;
              padding: 15px;
              border-radius: 12px;
              text-align: center;
            ">
              <div style="font-size: 1.8em; font-weight: 700;">${statusCounts.Closed || 0}</div>
              <div style="font-size: 0.8em; opacity: 0.9;">Closed Tickets</div>
            </div>
            
            ${type === 'assigned' ? `
            <div style="
              background: linear-gradient(135deg, #dc2626, #b91c1c);
              color: white;
              padding: 15px;
              border-radius: 12px;
              text-align: center;
            ">
              <div style="font-size: 1.8em; font-weight: 700;">${performance.criticalBugsFixed || 0}</div>
              <div style="font-size: 0.8em; opacity: 0.9;">Critical Fixed</div>
            </div>
            ` : `
            <div style="
              background: linear-gradient(135deg, #6366f1, #4f46e5);
              color: white;
              padding: 15px;
              border-radius: 12px;
              text-align: center;
            ">
              <div style="font-size: 1.8em; font-weight: 700;">${statusCounts['Ready for QA'] || 0}</div>
              <div style="font-size: 0.8em; opacity: 0.9;">Ready for QA</div>
            </div>
            `}
          </div>
          
          <!-- Status Distribution -->
          <div style="margin-bottom: 25px;">
            <h4 style="margin: 0 0 15px 0; color: #374151; font-size: 1.1em;">📊 Status Distribution</h4>
            <div style="
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
              gap: 10px;
            ">
              ${Object.entries(statusCounts)
                .filter(([status, count]) => status !== 'Total' && count > 0)
                .map(([status, count]) => `
                <div onclick="showDetailedTickets('${escapedName}', '${status}', '${type}')" style="
                  background: #f8fafc;
                  border: 2px solid #e2e8f0;
                  padding: 12px;
                  border-radius: 8px;
                  text-align: center;
                  cursor: pointer;
                  transition: all 0.2s ease;
                " onmouseover="this.style.background='#f1f5f9'; this.style.transform='translateY(-2px)'" onmouseout="this.style.background='#f8fafc'; this.style.transform='translateY(0)'">
                  <div style="font-size: 1.4em; font-weight: 700; color: #374151;">${count}</div>
                  <div style="font-size: 0.75em; color: #6b7280; text-transform: uppercase; font-weight: 600;">${status}</div>
                </div>
                `).join('')}
            </div>
          </div>
          
          <!-- Top Labels and Priorities -->
          <div style="
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 25px;
          ">
            <div>
              <h4 style="margin: 0 0 10px 0; color: #374151; font-size: 1em;">🏷️ Top Labels</h4>
              ${labels.length > 0 ? labels.slice(0, 5).map(([label, count]) => `
                <div style="
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  padding: 6px 10px;
                  background: #f8fafc;
                  border-radius: 6px;
                  margin-bottom: 5px;
                ">
                  <span style="font-size: 0.8em; color: #374151;">${label}</span>
                  <span style="
                    background: ${cardColor};
                    color: white;
                    padding: 2px 8px;
                    border-radius: 12px;
                    font-size: 0.7em;
                    font-weight: 600;
                  ">${count}</span>
                </div>
              `).join('') : '<p style="color: #9ca3af; font-style: italic; font-size: 0.9em;">No labels found</p>'}
            </div>
            
            <div>
              <h4 style="margin: 0 0 10px 0; color: #374151; font-size: 1em;">⚡ Priorities</h4>
              ${priorities.length > 0 ? priorities.slice(0, 5).map(([priority, count]) => `
                <div style="
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                  padding: 6px 10px;
                  background: #f8fafc;
                  border-radius: 6px;
                  margin-bottom: 5px;
                ">
                  <span style="font-size: 0.8em; color: #374151;">${priority}</span>
                  <span style="
                    background: ${priorityColors[priority] || '#6b7280'};
                    color: white;
                    padding: 2px 8px;
                    border-radius: 12px;
                    font-size: 0.7em;
                    font-weight: 600;
                  ">${count}</span>
                </div>
              `).join('') : '<p style="color: #9ca3af; font-style: italic; font-size: 0.9em;">No priorities found</p>'}
            </div>
          </div>
          
          <!-- Recent Activity -->
          <div>
            <h4 style="margin: 0 0 15px 0; color: #374151; font-size: 1em;">🕐 Recent Activity</h4>
            <div style="max-height: 200px; overflow-y: auto;">
              ${recentActivity.length > 0 ? recentActivity.map(activity => `
                <div style="
                  display: flex;
                  align-items: center;
                  justify-content: space-between;
                  padding: 8px 12px;
                  background: #f8fafc;
                  border-radius: 6px;
                  margin-bottom: 6px;
                  border-left: 3px solid ${cardColor};
                ">
                  <div>
                    <div style="font-weight: 600; color: #374151; font-size: 0.9em;">${activity.ticketId}</div>
                    <div style="font-size: 0.75em; color: #6b7280;">${activity.action}</div>
                  </div>
                  <div style="text-align: right;">
                    <div style="
                      background: ${priorityColors[activity.priority] || '#6b7280'};
                      color: white;
                      padding: 2px 6px;
                      border-radius: 4px;
                      font-size: 0.7em;
                      margin-bottom: 2px;
                    ">${activity.priority}</div>
                    <div style="font-size: 0.7em; color: #9ca3af;">${activity.date}</div>
                  </div>
                </div>
              `).join('') : '<p style="color: #9ca3af; font-style: italic; font-size: 0.9em;">No recent activity</p>'}
            </div>
          </div>
        </div>
      `;
    };
    
    // Generate Enhanced Assigned Tickets Dashboard
    const assignedRows = targetTesters
      .filter(testerName => this.enhancedAssigneeStats[testerName] && this.enhancedAssigneeStats[testerName].statusCounts.Total > 0)
      .map(testerName => {
        const stats = this.enhancedAssigneeStats[testerName].statusCounts;
        const escapedName = testerName.replace(/'/g, "\\'");
        return `
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 12px; font-weight: 600; background: #8b5cf6; color: white;">${testerName}</td>
          <td style="padding: 12px; text-align: center; background: ${stats['To Do'] > 0 ? '#6b7280' : '#f8fafc'}; color: ${stats['To Do'] > 0 ? 'white' : '#6b7280'}; font-weight: 600;">
            ${stats['To Do'] > 0 ? `<span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'To Do', 'assigned')" style="cursor: pointer; text-decoration: underline;">${stats['To Do']}</span>` : stats['To Do']}
          </td>
          <td style="padding: 12px; text-align: center; background: ${stats['QA'] > 0 ? '#ea580c' : '#f8fafc'}; color: ${stats['QA'] > 0 ? 'white' : '#6b7280'}; font-weight: 600;">
            ${stats['QA'] > 0 ? `<span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'QA', 'assigned')" style="cursor: pointer; text-decoration: underline;">${stats['QA']}</span>` : stats['QA']}
          </td>
          <td style="padding: 12px; text-align: center; background: ${stats['Ready for QA'] > 0 ? '#ca8a04' : '#f8fafc'}; color: ${stats['Ready for QA'] > 0 ? 'white' : '#6b7280'}; font-weight: 600;">
            ${stats['Ready for QA'] > 0 ? `<span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'Ready for QA', 'assigned')" style="cursor: pointer; text-decoration: underline;">${stats['Ready for QA']}</span>` : stats['Ready for QA']}
          </td>
          <td style="padding: 12px; text-align: center; background: ${stats['Ready for Release'] > 0 ? '#10b981' : '#f8fafc'}; color: ${stats['Ready for Release'] > 0 ? 'white' : '#6b7280'}; font-weight: 600;">
            ${stats['Ready for Release'] > 0 ? `<span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'Ready for Release', 'assigned')" style="cursor: pointer; text-decoration: underline;">${stats['Ready for Release']}</span>` : stats['Ready for Release']}
          </td>
          <td style="padding: 12px; text-align: center; background: ${stats['Closed'] > 0 ? '#16a34a' : '#f8fafc'}; color: ${stats['Closed'] > 0 ? 'white' : '#6b7280'}; font-weight: 600;">
            ${stats['Closed'] > 0 ? `<span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'Closed', 'assigned')" style="cursor: pointer; text-decoration: underline;">${stats['Closed']}</span>` : stats['Closed']}
          </td>
          <td style="padding: 12px; text-align: center; background: ${stats['Test Failed'] > 0 ? '#dc2626' : '#f8fafc'}; color: ${stats['Test Failed'] > 0 ? 'white' : '#6b7280'}; font-weight: 600;">
            ${stats['Test Failed'] > 0 ? `<span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'Test Failed', 'assigned')" style="cursor: pointer; text-decoration: underline;">${stats['Test Failed']}</span>` : stats['Test Failed']}
          </td>
          <td style="padding: 12px; text-align: center; background: #8b5cf6; color: white; font-weight: 700;">
            <span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'ALL', 'assigned')" style="cursor: pointer; text-decoration: underline;">${stats['Total']}</span>
          </td>
        </tr>`;
      }).join('');
      
    // Generate Enhanced Reported Tickets Dashboard
    const reportedRows = targetTesters
      .filter(testerName => this.enhancedReporterStats[testerName] && this.enhancedReporterStats[testerName].statusCounts.Total > 0)
      .map(testerName => {
        const stats = this.enhancedReporterStats[testerName].statusCounts;
        const escapedName = testerName.replace(/'/g, "\\'");
        return `
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 12px; font-weight: 600; background: #059669; color: white;">${testerName}</td>
          <td style="padding: 12px; text-align: center; background: ${stats['To Do'] > 0 ? '#6b7280' : '#f8fafc'}; color: ${stats['To Do'] > 0 ? 'white' : '#6b7280'}; font-weight: 600;">
            ${stats['To Do'] > 0 ? `<span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'To Do', 'reported')" style="cursor: pointer; text-decoration: underline;">${stats['To Do']}</span>` : stats['To Do']}
          </td>
          <td style="padding: 12px; text-align: center; background: ${stats['QA'] > 0 ? '#ea580c' : '#f8fafc'}; color: ${stats['QA'] > 0 ? 'white' : '#6b7280'}; font-weight: 600;">
            ${stats['QA'] > 0 ? `<span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'QA', 'reported')" style="cursor: pointer; text-decoration: underline;">${stats['QA']}</span>` : stats['QA']}
          </td>
          <td style="padding: 12px; text-align: center; background: ${stats['Ready for QA'] > 0 ? '#ca8a04' : '#f8fafc'}; color: ${stats['Ready for QA'] > 0 ? 'white' : '#6b7280'}; font-weight: 600;">
            ${stats['Ready for QA'] > 0 ? `<span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'Ready for QA', 'reported')" style="cursor: pointer; text-decoration: underline;">${stats['Ready for QA']}</span>` : stats['Ready for QA']}
          </td>
          <td style="padding: 12px; text-align: center; background: ${stats['Ready for Release'] > 0 ? '#10b981' : '#f8fafc'}; color: ${stats['Ready for Release'] > 0 ? 'white' : '#6b7280'}; font-weight: 600;">
            ${stats['Ready for Release'] > 0 ? `<span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'Ready for Release', 'reported')" style="cursor: pointer; text-decoration: underline;">${stats['Ready for Release']}</span>` : stats['Ready for Release']}
          </td>
          <td style="padding: 12px; text-align: center; background: ${stats['Closed'] > 0 ? '#16a34a' : '#f8fafc'}; color: ${stats['Closed'] > 0 ? 'white' : '#6b7280'}; font-weight: 600;">
            ${stats['Closed'] > 0 ? `<span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'Closed', 'reported')" style="cursor: pointer; text-decoration: underline;">${stats['Closed']}</span>` : stats['Closed']}
          </td>
          <td style="padding: 12px; text-align: center; background: ${stats['Test Failed'] > 0 ? '#dc2626' : '#f8fafc'}; color: ${stats['Test Failed'] > 0 ? 'white' : '#6b7280'}; font-weight: 600;">
            ${stats['Test Failed'] > 0 ? `<span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'Test Failed', 'reported')" style="cursor: pointer; text-decoration: underline;">${stats['Test Failed']}</span>` : stats['Test Failed']}
          </td>
          <td style="padding: 12px; text-align: center; background: #059669; color: white; font-weight: 700;">
            <span class="clickable-count" onclick="showTicketDetails('${escapedName}', 'ALL', 'reported')" style="cursor: pointer; text-decoration: underline;">${stats['Total']}</span>
          </td>
        </tr>`;
      }).join('');
      
    // Generate detailed tester cards
    const assigneeCards = targetTesters
      .filter(testerName => this.enhancedAssigneeStats[testerName] && this.enhancedAssigneeStats[testerName].statusCounts.Total > 0)
      .map(testerName => generateTesterCard(testerName, this.enhancedAssigneeStats[testerName], 'assigned'))
      .join('');
      
    const reporterCards = targetTesters
      .filter(testerName => this.enhancedReporterStats[testerName] && this.enhancedReporterStats[testerName].statusCounts.Total > 0)
      .map(testerName => generateTesterCard(testerName, this.enhancedReporterStats[testerName], 'reported'))
      .join('');
    
    // Sort bugs by creation date (newest first)
    const sortedBugs = [...this.jiraBugs].sort((a, b) => new Date(b.created) - new Date(a.created));
    
    // Group bugs by status
    const statusGroups = {
      'Open': [],
      'In Progress': [],
      'To Do': [],
      'Backlog': [],
      'In Review': [],
      'Done': [],
      'Fixed': [],
      'Resolved': [],
      'Closed': [],
      'Other': []
    };
    
    sortedBugs.forEach(bug => {
      const status = bug.status;
      if (statusGroups[status]) {
        statusGroups[status].push(bug);
      } else {
        statusGroups['Other'].push(bug);
      }
    });

    // Function to generate table rows for a status group
    const generateStatusSection = (statusName, bugs, isExpanded = false) => {
      if (bugs.length === 0) return '';
      
      const rows = bugs.map(bug => `
        <tr class="bug-row status-${statusName.replace(/\s+/g, '-').toLowerCase()}" data-labels="${(bug.labels || []).join(',')}" data-status="${statusName}" style="border-bottom: 1px solid #e2e8f0; ${!isExpanded ? 'display: none;' : ''}">
          <td style="padding: 12px; font-weight: 600; color: #3b82f6;">${bug.id}</td>
          <td style="padding: 12px; max-width: 300px; word-wrap: break-word;">${bug.summary}</td>
          <td style="padding: 12px;">
            <span style="background: ${priorityColors[bug.priority] || '#6b7280'}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8em;">${bug.priority}</span>
          </td>
          <td style="padding: 12px;">
            <span style="background: ${statusColors[bug.status] || '#6b7280'}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.8em;">${bug.status}</span>
          </td>
          <td style="padding: 12px;">
            ${bug.labels && bug.labels.length > 0 ? 
              bug.labels.map(label => `<span style="background: #e2e8f0; color: #374151; padding: 2px 6px; border-radius: 3px; font-size: 0.75em; margin-right: 4px;">${label}</span>`).join(' ') : 
              '<span style="color: #9ca3af; font-style: italic;">No labels</span>'}
          </td>
          <td style="padding: 12px;">${bug.reporter}</td>
          <td style="padding: 12px;">${bug.created}</td>
        </tr>`).join('');
      
      return `
        <tr class="status-header" onclick="toggleStatusGroup('${statusName.replace(/\s+/g, '-').toLowerCase()}')" style="background: #f1f5f9; cursor: pointer; border-top: 2px solid #cbd5e1;" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f1f5f9'">
          <td colspan="7" style="padding: 15px; font-weight: 700; color: #475569;">
            <span id="toggle-${statusName.replace(/\s+/g, '-').toLowerCase()}" style="font-size: 0.9em; margin-right: 8px; transition: transform 0.2s ease;">${isExpanded ? '▼' : '▶'}</span>
            <span style="background: ${statusColors[statusName] || '#6b7280'}; color: white; padding: 4px 12px; border-radius: 6px; margin-right: 10px;">${statusName}</span>
            <span style="color: #64748b;">• ${bugs.length} ticket${bugs.length > 1 ? 's' : ''}</span>
          </td>
        </tr>
        ${rows}`;
    };

    const statusSections = [
      generateStatusSection('Open', statusGroups['Open'], true), // Open by default
      generateStatusSection('In Progress', statusGroups['In Progress']),
      generateStatusSection('To Do', statusGroups['To Do']),
      generateStatusSection('Backlog', statusGroups['Backlog']),
      generateStatusSection('In Review', statusGroups['In Review']),
      generateStatusSection('Done', statusGroups['Done']),
      generateStatusSection('Fixed', statusGroups['Fixed']),
      generateStatusSection('Resolved', statusGroups['Resolved']),
      generateStatusSection('Closed', statusGroups['Closed']),
      generateStatusSection('Other', statusGroups['Other'])
    ].filter(section => section !== '').join('');
    
    return `
      <!-- Enhanced Bug Reports Dashboard with Assignee & Reporter Service -->
      <div class="bug-summary-card">
        <h2 style="margin: 0 0 10px 0; font-size: 2.2em;">🐛 JIRA Bug Reports Dashboard</h2>
        <p style="margin: 0; opacity: 0.9; font-size: 1.1em;">Live Quality Issues with Assignee Current Status & Reporter Service • Total Issues: ${this.jiraBugs.length}</p>
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
      
      <!-- Enhanced Service Navigation -->
      <div style="
        margin: 30px 0;
        background: linear-gradient(135deg, #f8fafc, #e2e8f0);
        border-radius: 16px;
        padding: 20px;
        text-align: center;
      ">
        <h3 style="margin: 0 0 20px 0; color: #374151; font-size: 1.5em;">🎯 Assignee & Reporter Services</h3>
        <div style="display: flex; justify-content: center; gap: 20px; flex-wrap: wrap;">
          <button onclick="showService('assignee-service')" class="service-nav-btn" style="
            background: linear-gradient(135deg, #8b5cf6, #7c3aed);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
          ">👤 Assignee Current Status Service</button>
          
          <button onclick="showService('reporter-service')" class="service-nav-btn" style="
            background: linear-gradient(135deg, #059669, #047857);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
          ">📝 Reporter Service Dashboard</button>
          
          <button onclick="showService('summary-view')" class="service-nav-btn" style="
            background: linear-gradient(135deg, #374151, #1f2937);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
          ">📊 Summary View</button>
        </div>
      </div>
      
      <!-- Assignee Current Status Service -->
      <div id="assignee-service" class="service-section" style="display: block;">
        <div style="margin: 30px 0; width: 100%;">
          <h3 style="margin: 0 0 30px 0; color: #374151; text-align: center; font-size: 1.8em;">👤 Assignee Current Status Service</h3>
          
          <!-- Summary Table -->
          <div style="width: 100%; max-width: 1200px; margin: 0 auto 40px auto; background: white; border-radius: 12px; padding: 30px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
            <h4 style="margin: 0 0 20px 0; color: #7c3aed; text-align: center; font-size: 1.4em;">📋 Current Assigned Tickets Status</h4>
            ${assignedRows ? `<table style="width: 100%; border-collapse: collapse; margin: 0 auto;">
              <thead>
                <tr style="background: #f1f5f9; border-bottom: 3px solid #cbd5e1;">
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #8b5cf6; border-radius: 8px 0 0 8px; font-size: 1em;">ASSIGNEE NAME</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #6b7280; font-size: 1em;">TO DO</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #ea580c; font-size: 1em;">QA</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #ca8a04; font-size: 1em;">READY FOR QA</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #10b981; font-size: 1em;">READY FOR RELEASE</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #16a34a; font-size: 1em;">CLOSED</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #dc2626; font-size: 1em;">TEST FAILED</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #8b5cf6; border-radius: 0 8px 8px 0; font-size: 1em;">TOTAL</th>
                </tr>
              </thead>
              <tbody>
                ${assignedRows}
              </tbody>
            </table>` : '<p style="text-align: center; color: #6b7280; font-style: italic;">No assigned tickets found for team members</p>'}
          </div>
          
          <!-- Detailed Assignee Cards -->
          <h4 style="margin: 40px 0 20px 0; color: #374151; text-align: center; font-size: 1.3em;">🔍 Detailed Assignee Status Cards</h4>
          ${assigneeCards}
        </div>
      </div>
      
      <!-- Reporter Service Dashboard -->
      <div id="reporter-service" class="service-section" style="display: none;">
        <div style="margin: 30px 0; width: 100%;">
          <h3 style="margin: 0 0 30px 0; color: #374151; text-align: center; font-size: 1.8em;">📝 Reporter Service Dashboard</h3>
          
          <!-- Summary Table -->
          <div style="width: 100%; max-width: 1200px; margin: 0 auto 40px auto; background: white; border-radius: 12px; padding: 30px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
            <h4 style="margin: 0 0 20px 0; color: #059669; text-align: center; font-size: 1.4em;">📝 Reported Bugs Status</h4>
            ${reportedRows ? `<table style="width: 100%; border-collapse: collapse; margin: 0 auto;">
              <thead>
                <tr style="background: #f1f5f9; border-bottom: 3px solid #cbd5e1;">
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #059669; border-radius: 8px 0 0 8px; font-size: 1em;">REPORTER NAME</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #6b7280; font-size: 1em;">TO DO</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #ea580c; font-size: 1em;">QA</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #ca8a04; font-size: 1em;">READY FOR QA</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #10b981; font-size: 1em;">READY FOR RELEASE</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #16a34a; font-size: 1em;">CLOSED</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #dc2626; font-size: 1em;">TEST FAILED</th>
                  <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #059669; border-radius: 0 8px 8px 0; font-size: 1em;">TOTAL</th>
                </tr>
              </thead>
              <tbody>
                ${reportedRows}
              </tbody>
            </table>` : '<p style="text-align: center; color: #6b7280; font-style: italic;">No reported tickets found for team members</p>'}
          </div>
          
          <!-- Detailed Reporter Cards -->
          <h4 style="margin: 40px 0 20px 0; color: #374151; text-align: center; font-size: 1.3em;">🔍 Detailed Reporter Analytics Cards</h4>
          ${reporterCards}
        </div>
      </div>
      
      <!-- Summary View -->
      <div id="summary-view" class="service-section" style="display: none;">
        <div style="margin: 30px 0;">
          <h3 style="margin: 0 0 30px 0; color: #374151; text-align: center; font-size: 1.8em;">📊 Bug Labels & Summary View</h3>
          
          <div class="bug-metrics-grid" style="margin: 30px 0;">
            <h3 style="margin: 0 0 20px 0; color: #374151; text-align: center; width: 100%;">🏷️ Bug Labels Distribution</h3>
            ${Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, count]) => `
              <div class="bug-metric-card label-filter-card" onclick="filterByLabel('${label}')" style="min-width: 200px; cursor: pointer; transition: transform 0.2s ease, box-shadow 0.2s ease;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 20px rgba(99, 102, 241, 0.3)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 10px rgba(0,0,0,0.1)'">
                <h3 style="color: #6366f1; margin: 0 0 10px 0; font-size: 0.9em; word-break: break-word;">${label}</h3>
                <div style="font-size: 2em; font-weight: 700; color: #6366f1;">${count}</div>
                <div style="font-size: 0.8em; color: #6b7280; margin-top: 5px;">ticket${count > 1 ? 's' : ''}</div>
              </div>
            `).join('')}
            ${Object.keys(labelCounts).length === 0 ? '<div style="text-align: center; color: #6b7280; font-style: italic; width: 100%;">No labels found</div>' : ''}
            <div class="bug-metric-card label-filter-card" onclick="showAllTickets()" style="min-width: 200px; cursor: pointer; transition: transform 0.2s ease, box-shadow 0.2s ease; background: #f8fafc;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 20px rgba(0,0,0,0.2)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 10px rgba(0,0,0,0.1)'">
              <h3 style="color: #374151; margin: 0 0 10px 0; font-size: 0.9em;">All Tickets</h3>
              <div style="font-size: 2em; font-weight: 700; color: #374151;">${this.jiraBugs.length}</div>
              <div style="font-size: 0.8em; color: #6b7280; margin-top: 5px;">total</div>
            </div>
          </div>
          
          <div class="bug-list">
            <h3 style="margin: 0 0 20px 0; color: #374151;">🎯 All BA QA Issues <span style="font-size: 0.8em; color: #6b7280;">(${this.jiraBugs.length} total tickets • Grouped by status • Click to expand/collapse • Click label above to filter)</span></h3>
            <table style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                  <th style="padding: 12px; text-align: left; font-weight: 600;">Bug ID</th>
                  <th style="padding: 12px; text-align: left; font-weight: 600;">Summary</th>
                  <th style="padding: 12px; text-align: left; font-weight: 600;">Priority</th>
                  <th style="padding: 12px; text-align: left; font-weight: 600;">Status</th>
                  <th style="padding: 12px; text-align: left; font-weight: 600;">Labels</th>
                  <th style="padding: 12px; text-align: left; font-weight: 600;">Reporter</th>
                  <th style="padding: 12px; text-align: left; font-weight: 600;">Created</th>
                </tr>
              </thead>
              <tbody>
                ${statusSections}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  }

  generateRegressionReportsHTML() {
    if (!process.env.ENABLE_BUG_REPORTS || process.env.ENABLE_BUG_REPORTS !== 'true') {
      return '<p style="text-align: center; color: #6b7280; font-style: italic;">🔧 O2C Regression Reports feature is disabled in this environment.</p>';
    }
    
    // Create tables for assigned and reported regression tickets
    const assignedRows = Object.entries(this.regressionAssignedStats)
      .sort((a, b) => b[1]['Total'] - a[1]['Total'])
      .map(([tester, stats]) => `
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 12px 20px; font-weight: 600; color: #374151; background: #f8fafc;">${tester}</td>
          <td style="padding: 12px 20px; text-align: center; background: #f3f4f6; color: #6b7280; font-weight: 600;">${stats['To Do']}</td>
          <td style="padding: 12px 20px; text-align: center; background: #fef3c7; color: #d97706; font-weight: 600;">${stats['QA']}</td>
          <td style="padding: 12px 20px; text-align: center; background: #fef9c3; color: #ca8a04; font-weight: 600;">${stats['Ready for QA']}</td>
          <td style="padding: 12px 20px; text-align: center; background: #d1fae5; color: #10b981; font-weight: 600;">${stats['Ready for Release']}</td>
          <td style="padding: 12px 20px; text-align: center; background: #dcfce7; color: #16a34a; font-weight: 600;">${stats['Closed']}</td>
          <td style="padding: 12px 20px; text-align: center; background: #fecaca; color: #dc2626; font-weight: 600;">${stats['Test Failed']}</td>
          <td style="padding: 12px 20px; text-align: center; background: #e0e7ff; color: #6366f1; font-weight: 700; font-size: 1.1em;">${stats['Total']}</td>
        </tr>
      `).join('');
    
    const reportedRows = Object.entries(this.regressionReportedStats)
      .sort((a, b) => b[1]['Total'] - a[1]['Total'])
      .map(([tester, stats]) => `
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 12px 20px; font-weight: 600; color: #374151; background: #f8fafc;">${tester}</td>
          <td style="padding: 12px 20px; text-align: center; background: #f3f4f6; color: #6b7280; font-weight: 600;">${stats['To Do']}</td>
          <td style="padding: 12px 20px; text-align: center; background: #fef3c7; color: #d97706; font-weight: 600;">${stats['QA']}</td>
          <td style="padding: 12px 20px; text-align: center; background: #fef9c3; color: #ca8a04; font-weight: 600;">${stats['Ready for QA']}</td>
          <td style="padding: 12px 20px; text-align: center; background: #d1fae5; color: #10b981; font-weight: 600;">${stats['Ready for Release']}</td>
          <td style="padding: 12px 20px; text-align: center; background: #dcfce7; color: #16a34a; font-weight: 600;">${stats['Closed']}</td>
          <td style="padding: 12px 20px; text-align: center; background: #fecaca; color: #dc2626; font-weight: 600;">${stats['Test Failed']}</td>
          <td style="padding: 12px 20px; text-align: center; background: #e0e7ff; color: #6366f1; font-weight: 700; font-size: 1.1em;">${stats['Total']}</td>
        </tr>
      `).join('');

    return `
      <!-- O2C Regression Dashboard -->
      <div class="bug-summary-card">
        <h2 style="margin: 0 0 10px 0; font-size: 2.2em;">🔄 O2C Regression Dashboard</h2>
        <p style="margin: 0; opacity: 0.9; font-size: 1.1em;">Regression Issues with o2c_regression label • Focus on Quality Regressions</p>
      </div>
      
      <div style="margin: 30px 0; width: 100%;">
        <h3 style="margin: 0 0 30px 0; color: #374151; text-align: center; font-size: 1.8em;">🔄 O2C Regression Tracking</h3>
        
        <!-- Assigned Regression Tickets Section -->
        <div style="width: 100%; max-width: 1200px; margin: 0 auto 40px auto; background: white; border-radius: 12px; padding: 30px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
          <h4 style="margin: 0 0 20px 0; color: #dc2626; text-align: center; font-size: 1.4em;">🔄 Assigned Regression Tickets</h4>
          ${assignedRows ? `<table style="width: 100%; border-collapse: collapse; margin: 0 auto;">
            <thead>
              <tr style="background: #f1f5f9; border-bottom: 3px solid #cbd5e1;">
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #dc2626; border-radius: 8px 0 0 8px; font-size: 1em;">ASSIGNEE NAME</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #6b7280; font-size: 1em;">TO DO</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #ea580c; font-size: 1em;">QA</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #ca8a04; font-size: 1em;">READY FOR QA</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #10b981; font-size: 1em;">READY FOR RELEASE</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #16a34a; font-size: 1em;">CLOSED</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #dc2626; font-size: 1em;">TEST FAILED</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #dc2626; border-radius: 0 8px 8px 0; font-size: 1em;">TOTAL</th>
              </tr>
            </thead>
            <tbody>
              ${assignedRows}
            </tbody>
          </table>` : '<p style="text-align: center; color: #6b7280; font-style: italic;">No assigned regression tickets found for team members</p>'}
        </div>
        
        <!-- Reported Regression Tickets Section -->
        <div style="width: 100%; max-width: 1200px; margin: 0 auto; background: white; border-radius: 12px; padding: 30px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
          <h4 style="margin: 0 0 20px 0; color: #dc2626; text-align: center; font-size: 1.4em;">📝 Reported Regression Tickets</h4>
          ${reportedRows ? `<table style="width: 100%; border-collapse: collapse; margin: 0 auto;">
            <thead>
              <tr style="background: #f1f5f9; border-bottom: 3px solid #cbd5e1;">
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #dc2626; border-radius: 8px 0 0 8px; font-size: 1em;">REPORTER NAME</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #6b7280; font-size: 1em;">TO DO</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #ea580c; font-size: 1em;">QA</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #ca8a04; font-size: 1em;">READY FOR QA</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #10b981; font-size: 1em;">READY FOR RELEASE</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #16a34a; font-size: 1em;">CLOSED</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #dc2626; font-size: 1em;">TEST FAILED</th>
                <th style="padding: 15px 20px; text-align: center; font-weight: 700; color: white; background: #dc2626; border-radius: 0 8px 8px 0; font-size: 1em;">TOTAL</th>
              </tr>
            </thead>
            <tbody>
              ${reportedRows}
            </tbody>
          </table>` : '<p style="text-align: center; color: #6b7280; font-style: italic;">No reported regression tickets found for team members</p>'}
        </div>
      </div>
    `;
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