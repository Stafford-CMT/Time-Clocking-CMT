'use strict';

/* Configuration -> Syspro tables (admins only): a read-only look at the tables
 * and views in the Syspro company database. Only SELECTs are run, and a table
 * name from the browser is only used once it has been found in SQL Server's own
 * list, so nothing typed can reach the SQL text. The SQL login is read only too.
 */
// Loaded on first use, not at start-up: the SQL Server package is large and only admins browsing Syspro need it.
let mssql = null;
const sql = new Proxy({}, { get: (target, key) => (mssql ||= sysproService.loadMssql())[key] });
const sysproService = require('./sysproService');
const { getSqlPool } = sysproService;
const ApiError = require('../utils/ApiError');

const PAGE_SIZE = 100;
const MAX_CELL = 500; // characters shown per cell
const FILTERABLE = /char|text|int|numeric|decimal|money|float|real|date|time|bit|uniqueidentifier/i;

// [name] with any ] doubled: SQL Server's QUOTENAME, for names already checked against the catalogue.
const quote = (name) => `[${String(name).replace(/]/g, ']]')}]`;

async function listTables() {
  const pool = await getSqlPool();
  const result = await pool.request().query(`
    SELECT t.TABLE_SCHEMA AS [schema], t.TABLE_NAME AS name, t.TABLE_TYPE AS type,
           (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME) AS columns,
           (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = OBJECT_ID(QUOTENAME(t.TABLE_SCHEMA) + '.' + QUOTENAME(t.TABLE_NAME)) AND p.index_id IN (0, 1)) AS rows
    FROM INFORMATION_SCHEMA.TABLES t
    ORDER BY t.TABLE_NAME, t.TABLE_SCHEMA`);
  return result.recordset.map((row) => ({
    schema: row.schema,
    name: row.name,
    view: row.type === 'VIEW',
    columns: row.columns,
    rows: row.rows === null ? null : Number(row.rows),
  }));
}

function showValue(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `(binary, ${value.length} bytes)`;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return String(value);
    const text = value.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');
    return text.endsWith(' 00:00:00') ? text.slice(0, 10) : text;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value).replace(/\s+$/, ''); // Syspro pads char columns with spaces
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text;
}

async function readTable({ schema = 'dbo', name, page = 1, filterColumn = '', filterText = '' }) {
  if (!name) throw new ApiError(400, 'Choose a table');
  const pool = await getSqlPool();
  const columnsResult = await pool.request()
    .input('schema', sql.NVarChar, schema)
    .input('name', sql.NVarChar, name)
    .query(`
      SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS type, c.CHARACTER_MAXIMUM_LENGTH AS length,
             c.NUMERIC_PRECISION AS precision, c.NUMERIC_SCALE AS scale, c.IS_NULLABLE AS nullable,
             CASE WHEN k.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS isKey, k.ORDINAL_POSITION AS keyOrder
      FROM INFORMATION_SCHEMA.COLUMNS c
      LEFT JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        ON tc.TABLE_SCHEMA = c.TABLE_SCHEMA AND tc.TABLE_NAME = c.TABLE_NAME AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
        ON k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_NAME = c.COLUMN_NAME
      WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @name
      ORDER BY c.ORDINAL_POSITION`);
  const columns = columnsResult.recordset;
  if (!columns.length) throw new ApiError(404, `There is no table called ${name}`);

  const keys = columns.filter((column) => column.isKey).sort((a, b) => a.keyOrder - b.keyOrder);
  const orderBy = (keys.length ? keys : [columns[0]]).map((column) => quote(column.name)).join(', ');
  const from = `${quote(schema)}.${quote(name)}`;

  const request = pool.request();
  let where = '';
  const find = String(filterText || '').trim();
  if (find) {
    const column = columns.find((c) => c.name === filterColumn);
    if (!column) throw new ApiError(400, 'Choose a column to filter on');
    if (!FILTERABLE.test(column.type)) throw new ApiError(400, `${column.name} can't be filtered (it holds ${column.type} data)`);
    request.input('find', sql.NVarChar, `%${find.replace(/[[%_]/g, '[$&]')}%`);
    where = `WHERE CONVERT(nvarchar(4000), ${quote(column.name)}, 121) LIKE @find`;
  }
  const pageNumber = Math.max(1, Math.floor(Number(page)) || 1);
  request.input('skip', sql.Int, (pageNumber - 1) * PAGE_SIZE);
  request.input('take', sql.Int, PAGE_SIZE);
  // A filtered count runs alongside the page; an unfiltered total comes from the table's row count.
  const result = await request.query(`
    SELECT * FROM ${from} ${where} ORDER BY ${orderBy} OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY;
    ${where ? `SELECT COUNT_BIG(*) AS total FROM ${from} ${where};` : `SELECT SUM(p.rows) AS total FROM sys.partitions p WHERE p.object_id = OBJECT_ID('${from.replace(/'/g, "''")}') AND p.index_id IN (0, 1);`}`);
  const names = columns.map((column) => column.name);
  const total = result.recordsets[1][0]?.total;
  return {
    schema,
    name,
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type + (column.length ? `(${column.length === -1 ? 'max' : column.length})` : /decimal|numeric/i.test(column.type) ? `(${column.precision},${column.scale})` : ''),
      key: Boolean(column.isKey),
      nullable: column.nullable === 'YES',
      filterable: FILTERABLE.test(column.type),
    })),
    rows: result.recordsets[0].map((row) => names.map((columnName) => showValue(row[columnName]))),
    page: pageNumber,
    pageSize: PAGE_SIZE,
    total: total === null || total === undefined ? null : Number(total),
    sortedBy: keys.length ? keys.map((column) => column.name) : [columns[0].name],
  };
}

module.exports = { listTables, readTable };
