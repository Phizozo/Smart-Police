import ExcelJS from 'exceljs';
import {ReplitConnectors} from '@replit/connectors-sdk';

const workbookPath = '/v1.0/me/drive/root:/Smart_Police_Registrations.xlsx:/content';
const contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function safeCell(value) {
  if (typeof value === 'string' && /^[\s]*[=+\-@]/u.test(value)) return `'${value}`;
  return value;
}

export async function buildRegistrationWorkbook(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('Database sheets were not provided.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Smart Police';
  workbook.subject = 'Live operational database copy';
  workbook.title = 'SmartPolice Database';
  workbook.created = new Date();
  const tableNames = new Set();
  for (const data of sheets) {
    if (!data || typeof data.name !== 'string' || typeof data.tableName !== 'string' ||
        !Array.isArray(data.headers) || !Array.isArray(data.rows) ||
        data.headers.length === 0 || data.headers.some(header => typeof header !== 'string' || !header.trim()) ||
        data.rows.some(row => !Array.isArray(row) || row.length !== data.headers.length)) {
      throw new Error('A database worksheet has an invalid structure.');
    }
    if (tableNames.has(data.tableName)) throw new Error('Database worksheet names must be unique.');
    tableNames.add(data.tableName);
    const sheet = workbook.addWorksheet(data.name);
    sheet.views = [{state: 'frozen', ySplit: 1}];
    sheet.addTable({
      name: data.tableName,
      ref: 'A1',
      headerRow: true,
      totalsRow: false,
      style: {theme: 'TableStyleMedium2', showRowStripes: true},
      columns: data.headers.map(name => ({name, filterButton: true})),
      rows: data.rows.map(row => row.map(safeCell))
    });
    data.headers.forEach((header, index) => {
      const sampleWidth = data.rows.slice(0, 50).reduce((max, row) => Math.max(max, String(row[index] ?? '').length), header.length);
      sheet.getColumn(index + 1).width = Math.min(60, Math.max(14, sampleWidth + 2));
    });
  }
  return workbook.xlsx.writeBuffer();
}

async function readInput() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('Database input is too large.');
  }
  const payload = JSON.parse(text || '{}');
  if (!Array.isArray(payload.sheets)) throw new Error('Database sheets were not provided.');
  return payload.sheets;
}

async function selfTest() {
  const buffer = await buildRegistrationWorkbook([
    {name: 'Users', tableName: 'SPUsers', headers: ['Account ID','Full name'], rows: [[1,'Sample Person']]},
    {name: 'Cases', tableName: 'SPCases', headers: ['Case ID','Title'], rows: [[2,'=1+1']]}
  ]);
  const check = new ExcelJS.Workbook();
  await check.xlsx.load(buffer);
  const users = check.getWorksheet('Users');
  const cases = check.getWorksheet('Cases');
  if (!users || users.getCell('B2').value !== 'Sample Person' || !users.getTable('SPUsers') ||
      !cases || cases.getCell('B2').value !== "'=1+1" || !cases.getTable('SPCases')) {
    throw new Error('The database worksheets did not round-trip safely.');
  }
}

async function main() {
  if (process.argv.includes('--self-test')) {
    await selfTest();
    console.log('Database workbook self-test passed.');
    return;
  }
  const sheets = await readInput();
  const workbook = await buildRegistrationWorkbook(sheets);
  const connectors = new ReplitConnectors();
  const response = await connectors.proxy('onedrive', workbookPath, {
    method: 'PUT',
    headers: {'Content-Type': contentType},
    body: Buffer.from(workbook),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`OneDrive upload failed with HTTP ${response.status}.`);
  const item = await response.json();
  if (!item.id || !item.webUrl) throw new Error('OneDrive did not return the workbook link.');
  process.stdout.write(JSON.stringify({
    id: item.id,
    name: item.name,
    webUrl: item.webUrl,
    sheetCount: sheets.length,
    recordCount: sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0)
  }));
}

main().catch(error => {
  console.error(error?.message || 'OneDrive database sync failed.');
  process.exitCode = 1;
});
