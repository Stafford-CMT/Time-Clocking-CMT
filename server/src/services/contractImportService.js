'use strict';

/* Contract information from Excel (admins only, on the Contract information
 * screen). The download is a workbook of what is there today: a Contracts
 * sheet (number, customer, machine type) and a Suffixes sheet (number, suffix,
 * description). Rows added underneath are loaded by the import, which only
 * ever ADDS: a contract or suffix that is already there is left as it is, and
 * where the sheet disagrees with it the difference is listed so it can be put
 * right by hand. Names follow the lists' letter case (utils/textCase), and a
 * customer, machine type or suffix description that isn't in its list yet is
 * added to it. Tiles for new suffixes are made as for any Contract information
 * save (setupRepo.syncContractTiles), on no one's dashboard.
 *
 * The import runs twice: first as a check (nothing saved, the report is shown),
 * then again with apply, which works the report out afresh inside the
 * transaction so it saves exactly what the data then allows.
 */
const ExcelJS = require('exceljs');
const { getPool, withTransaction } = require('../config/db');
const setupRepo = require('../repositories/setupRepo');
const ApiError = require('../utils/ApiError');
const { uid } = require('../utils/ids');
const { upperCase, sentenceCase, titleCase } = require('../utils/textCase');

const MAX_BYTES = 3 * 1024 * 1024;
const tidy = (text) => String(text ?? '').trim().replace(/\s+/g, ' ');
const key = (text) => tidy(text).toUpperCase();
const LISTS = { customers: 'customers', machineTypes: 'machine_types', suffixDescriptions: 'suffix_descriptions' };

async function readCurrent(db) {
  const contracts = (await db.query('SELECT id, number, customer_name, machine_type, sort_order FROM contract_info ORDER BY sort_order')).rows;
  const suffixes = (await db.query('SELECT id, contract_info_id, letter, description, sort_order FROM contract_info_suffixes ORDER BY sort_order')).rows;
  const lists = {};
  for (const [name, table] of Object.entries(LISTS)) lists[name] = (await db.query(`SELECT name FROM ${table} ORDER BY sort_order`)).rows.map((r) => r.name);
  return { contracts, suffixes, lists };
}

async function workbook() {
  const { contracts, suffixes } = await readCurrent(getPool());
  const book = new ExcelJS.Workbook();
  book.creator = 'Time Slide';
  const sheet = (name, columns, rows) => {
    const ws = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    rows.forEach((row) => ws.addRow(row));
    return ws;
  };
  const byId = Object.fromEntries(contracts.map((c) => [c.id, c]));
  sheet('Contracts', [{ header: 'Contract number', key: 'number', width: 18 }, { header: 'Customer', key: 'customer', width: 34 }, { header: 'Machine type', key: 'machine', width: 20 }],
    contracts.filter((c) => tidy(c.number)).map((c) => ({ number: c.number, customer: c.customer_name, machine: c.machine_type })));
  sheet('Suffixes', [{ header: 'Contract number', key: 'number', width: 18 }, { header: 'Suffix', key: 'letter', width: 10 }, { header: 'Description', key: 'description', width: 40 }],
    suffixes.filter((s) => byId[s.contract_info_id] && tidy(byId[s.contract_info_id].number))
      .sort((a, b) => byId[a.contract_info_id].sort_order - byId[b.contract_info_id].sort_order || a.sort_order - b.sort_order)
      .map((s) => ({ number: byId[s.contract_info_id].number, letter: s.letter, description: s.description })));
  const help = book.addWorksheet('How to');
  help.getColumn(1).width = 110;
  [
    'Contract information for Time Slide',
    '',
    'Contracts sheet: one row per contract (number, customer, machine type).',
    'Suffixes sheet: one row per suffix (the contract number it belongs to, the suffix letter, its description).',
    'The rows already here are what Time Slide has today. Add the missing ones underneath; you can leave the existing rows in or delete them.',
    'A suffix\'s contract must be in Time Slide already, or on the Contracts sheet.',
    '',
    'Then in Time Slide: Contract information > Import from Excel. It checks the file first and shows what it would add.',
    'Nothing already in Time Slide is changed. Where a row disagrees with it (a different customer, say) the check lists it, to put right by hand.',
    'Letter case is made to match the lists: machine types in capitals, customers in title case, descriptions in sentence case.',
    'Each new suffix gets a tile, on no one\'s dashboard until they add it.',
  ].forEach((line, i) => { help.addRow([line]); if (i === 0) help.getRow(1).font = { bold: true, size: 13 }; });
  const stamp = new Date().toISOString().slice(0, 10);
  return { buffer: Buffer.from(await book.xlsx.writeBuffer()), filename: `time-slide-contracts-${stamp}.xlsx` };
}

// The sheet's rows as { row, values by column name }, found by heading so the columns can be in any order.
function readSheet(book, name, fields) {
  const ws = book.worksheets.find((w) => w.name.trim().toLowerCase() === name);
  if (!ws) return null;
  const heads = {};
  ws.getRow(1).eachCell((cell, col) => {
    const text = tidy(cell.text).toLowerCase();
    for (const [field, test] of Object.entries(fields)) if (!heads[field] && test(text)) { heads[field] = col; break; }
  });
  const missing = Object.keys(fields).filter((field) => !heads[field]);
  if (missing.length) throw new ApiError(400, `The ${ws.name} sheet has no "${missing.map((f) => ({ number: 'Contract number', customer: 'Customer', machine: 'Machine type', letter: 'Suffix', description: 'Description' }[f])).join('", "')}" column in its first row.`);
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = Object.fromEntries(Object.entries(heads).map(([field, col]) => [field, tidy(row.getCell(col).text)]));
    if (Object.values(values).some(Boolean)) rows.push({ row: rowNumber, ...values });
  });
  return rows;
}

async function readUpload(body) {
  const match = /^data:[^;,]*;base64,(.+)$/s.exec((body && body.dataUrl) || '');
  if (!match) throw new ApiError(400, 'No spreadsheet was sent.');
  const data = Buffer.from(match[1], 'base64');
  if (data.length > MAX_BYTES) throw new ApiError(400, 'That spreadsheet is too big (3 MB at most).');
  const book = new ExcelJS.Workbook();
  try { await book.xlsx.load(data); } catch { throw new ApiError(400, 'That file could not be read as an Excel workbook (.xlsx).'); }
  const contracts = readSheet(book, 'contracts', { number: (t) => t.includes('contract') || t === 'number', customer: (t) => t.includes('customer'), machine: (t) => t.includes('machine') });
  const suffixes = readSheet(book, 'suffixes', { number: (t) => t.includes('contract') || t === 'number', letter: (t) => t.includes('suffix') && !t.includes('desc'), description: (t) => t.includes('desc') });
  if (!contracts && !suffixes) throw new ApiError(400, 'The workbook needs a sheet called Contracts or Suffixes. Download the spreadsheet from this screen to start from.');
  return { contracts: contracts || [], suffixes: suffixes || [], sheets: [contracts && 'Contracts', suffixes && 'Suffixes'].filter(Boolean) };
}

// What the sheet rows would add, given what is there now. Nothing is saved here.
function plan(sheet, current) {
  const report = { sheets: sheet.sheets, contracts: { add: [], same: 0 }, suffixes: { add: [], same: 0 }, differences: [], problems: [], newLists: { customers: [], machineTypes: [], suffixDescriptions: [] } };
  const listKeys = Object.fromEntries(Object.entries(current.lists).map(([name, names]) => [name, new Set(names.map(key))]));
  const addToList = (name, value) => { if (value && !listKeys[name].has(key(value))) { listKeys[name].add(key(value)); report.newLists[name].push(value); } };
  const contractsByNumber = new Map(); // key(number) -> { id, number, customer, machine, sheetRow? }
  current.contracts.forEach((c) => { if (tidy(c.number) && !contractsByNumber.has(key(c.number))) contractsByNumber.set(key(c.number), { id: c.id, number: c.number, customer: c.customer_name, machine: c.machine_type }); });
  const differ = (a, b) => key(a) !== key(b);

  sheet.contracts.forEach((r) => {
    if (!r.number) { report.problems.push({ sheet: 'Contracts', row: r.row, message: 'No contract number' }); return; }
    const customer = titleCase(r.customer); const machine = upperCase(r.machine);
    const existing = contractsByNumber.get(key(r.number));
    if (!existing) {
      const add = { id: uid('info'), number: tidy(r.number), customer, machine, row: r.row };
      contractsByNumber.set(key(r.number), { ...add, sheetRow: r.row });
      report.contracts.add.push(add); addToList('customers', customer); addToList('machineTypes', machine);
      return;
    }
    const where = existing.sheetRow ? `row ${existing.sheetRow} of the sheet` : 'Time Slide';
    const diffs = [['Customer', existing.customer, customer], ['Machine type', existing.machine, machine]].filter(([, had, now]) => now && differ(had, now));
    if (diffs.length) diffs.forEach(([field, had, now]) => report.differences.push({ sheet: 'Contracts', row: r.row, item: tidy(r.number), field, existing: had || '(blank)', sheetValue: now, where }));
    else if (!existing.sheetRow) report.contracts.same += 1;
  });

  const suffixKeys = new Map(); // key(number)|key(letter) -> { description, sheetRow? }
  const infoById = Object.fromEntries(current.contracts.map((c) => [c.id, c]));
  current.suffixes.forEach((s) => { const info = infoById[s.contract_info_id]; if (info && tidy(info.number)) suffixKeys.set(`${key(info.number)}|${key(s.letter)}`, { description: s.description }); });
  sheet.suffixes.forEach((r) => {
    if (!r.number) { report.problems.push({ sheet: 'Suffixes', row: r.row, message: 'No contract number' }); return; }
    if (!r.letter) { report.problems.push({ sheet: 'Suffixes', row: r.row, message: `No suffix for contract ${r.number}` }); return; }
    const contract = contractsByNumber.get(key(r.number));
    if (!contract) { report.problems.push({ sheet: 'Suffixes', row: r.row, message: `Contract ${r.number} isn't in Time Slide or on the Contracts sheet` }); return; }
    const letter = key(r.letter); const description = sentenceCase(r.description);
    const existing = suffixKeys.get(`${key(r.number)}|${letter}`);
    if (!existing) {
      suffixKeys.set(`${key(r.number)}|${letter}`, { description, sheetRow: r.row });
      report.suffixes.add.push({ id: uid('suffix'), contractId: contract.id, number: contract.number, letter, description, row: r.row });
      addToList('suffixDescriptions', description);
      return;
    }
    if (description && differ(existing.description, description)) report.differences.push({ sheet: 'Suffixes', row: r.row, item: `${tidy(r.number)} ${letter}`, field: 'Description', existing: existing.description || '(blank)', sheetValue: description, where: existing.sheetRow ? `row ${existing.sheetRow} of the sheet` : 'Time Slide' });
    else if (!existing.sheetRow) report.suffixes.same += 1;
  });
  return report;
}

async function save(db, report) {
  const next = async (table, where = '') => (await db.query(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM ${table} ${where}`)).rows[0].n;
  for (const [name, table] of Object.entries(LISTS)) {
    let order = await next(table);
    for (const value of report.newLists[name]) { await db.query(`INSERT INTO ${table} (name, sort_order) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [value, order]); order += 1; }
  }
  let order = await next('contract_info');
  for (const c of report.contracts.add) {
    await db.query('INSERT INTO contract_info (id, number, machine_type, customer_name, sort_order) VALUES ($1, $2, $3, $4, $5)', [c.id, c.number, c.machine, c.customer, order]);
    order += 1;
  }
  for (const s of report.suffixes.add) {
    const position = (await db.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM contract_info_suffixes WHERE contract_info_id = $1', [s.contractId])).rows[0].n;
    await db.query('INSERT INTO contract_info_suffixes (id, contract_info_id, letter, description, sort_order) VALUES ($1, $2, $3, $4, $5)', [s.id, s.contractId, s.letter, s.description, position]);
  }
  await setupRepo.syncContractTiles(db);
}

async function importWorkbook(body) {
  const sheet = await readUpload(body);
  if (!body.apply) return { applied: false, ...plan(sheet, await readCurrent(getPool())) };
  return withTransaction(async (db) => {
    await db.query('LOCK TABLE contract_info IN SHARE ROW EXCLUSIVE MODE'); // no Contract information save in between
    const report = plan(sheet, await readCurrent(db));
    await save(db, report);
    return { applied: true, ...report };
  });
}

module.exports = { workbook, importWorkbook, plan, readUpload }; // plan and readUpload: for checking without a database
