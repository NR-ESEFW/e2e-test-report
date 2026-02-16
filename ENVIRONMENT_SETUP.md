# 🔐 Environment Variables Setup Guide

## 📋 Required Environment Variables

Copy `.env.example` to `.env` and fill in your actual credentials:

```bash
cp .env.example .env
```

### 📊 Google Sheets Configuration
- `GOOGLE_SHEETS_SPREADSHEET_ID` - Your Google Sheets ID from the URL
- `GOOGLE_SHEETS_GID` - Specific sheet GID number  
- `GOOGLE_CLIENT_ID` - From Google Cloud Console OAuth 2.0
- `GOOGLE_CLIENT_SECRET` - From Google Cloud Console OAuth 2.0

### 🐛 JIRA Integration Configuration
- `JIRA_BASE_URL` - Your Atlassian JIRA instance URL (e.g., https://company.atlassian.net)
- `JIRA_EMAIL` - Service account email for API access
- `JIRA_API_TOKEN` - Generate from Atlassian Account Settings → Security → API tokens
- `JIRA_CLIENT_SECRET` - JIRA client secret for API access

### 🧪 X-Ray Test Configuration  
- `XRAY_CLIENT_ID` - X-Ray client ID for test execution
- `XRAY_CLIENT_SECRET` - X-Ray client secret

## 🚨 Security Guidelines

1. **Never commit `.env` files** - They're already in `.gitignore`
2. **Use service accounts** for production environments
3. **Rotate API tokens** regularly
4. **Use different credentials** for different environments (dev/staging/prod)

## 🔄 Setup for New Team Members

1. Get credentials from team lead/admin
2. Copy `.env.example` to `.env`
3. Fill in the actual values
4. Test with: `node google-sheets-pivot-reporter-oauth-manual.js`

## 🌍 Environment-Specific Configuration

For different environments, you can create:
- `.env.development`
- `.env.staging` 
- `.env.production`

And load them using: `dotenv.config({ path: '.env.production' })`