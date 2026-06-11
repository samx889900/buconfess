import { GoogleSpreadsheet } from 'google-spreadsheet';

// Initialize the sheet
let doc: GoogleSpreadsheet | null = null;

export async function getGoogleSheet() {
  if (doc) return doc;

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_SHEET_ID) {
    throw new Error('Google Sheets credentials are not set in environment variables.');
  }

  // Handle newlines in private key securely
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

  doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: privateKey,
  });

  await doc.loadInfo(); // loads document properties and worksheets
  return doc;
}
