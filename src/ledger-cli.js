import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addEntry, isValidDate, isValidMonth, summarize } from './ledger.js';

const USAGE = [
  'usage:',
  '  node src/ledger-cli.js add --date YYYY-MM-DD --amount N [--note TEXT] [--file PATH]',
  '  node src/ledger-cli.js sum --month YYYY-MM [--file PATH]',
].join('\n');
const ADD_FLAGS = new Set(['--date', '--amount', '--note', '--file']);
const SUM_FLAGS = new Set(['--month', '--file']);

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new TypeError(`${flag} requires a value`);
  }
  return value;
}

function parseAmount(value) {
  if (value.trim() === '') {
    throw new TypeError('--amount must be a number');
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    throw new TypeError('--amount must be a number');
  }
  return amount;
}

function parseFlags(argv, allowedFlags) {
  const args = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!allowedFlags.has(flag)) {
      throw new TypeError(`unknown argument: ${flag}`);
    }
    if (seen.has(flag)) {
      throw new TypeError(`duplicate argument: ${flag}`);
    }
    seen.add(flag);
    args[flag.slice(2)] = readValue(argv, i, flag);
    i += 1;
  }
  return args;
}

function resolveFile(args) {
  const file = args.file ?? process.env.LEDGER_FILE ?? 'data/ledger.json';
  if (file.trim() === '') {
    throw new TypeError('--file must be a non-empty path');
  }
  return file;
}

export function parseAddArgs(argv) {
  const args = parseFlags(argv, ADD_FLAGS);

  if (args.date === undefined) {
    throw new TypeError('--date is required');
  }
  if (!isValidDate(args.date)) {
    throw new TypeError('--date must be a valid YYYY-MM-DD date');
  }
  if (args.amount === undefined) {
    throw new TypeError('--amount is required');
  }

  return {
    date: args.date,
    amount: parseAmount(args.amount),
    note: args.note,
    file: resolveFile(args),
  };
}

export function parseSumArgs(argv) {
  const args = parseFlags(argv, SUM_FLAGS);

  if (args.month === undefined) {
    throw new TypeError('--month is required');
  }
  if (!isValidMonth(args.month)) {
    throw new TypeError('--month must be a valid YYYY-MM month');
  }

  return {
    month: args.month,
    file: resolveFile(args),
  };
}

function readEntries(file) {
  if (!existsSync(file)) {
    return [];
  }
  const entries = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) {
    throw new TypeError('ledger file must contain a JSON array');
  }
  return entries;
}

function writeEntries(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

export function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'add') {
    const { date, amount, note, file } = parseAddArgs(rest);
    const entries = addEntry(readEntries(file), { date, amount, note });
    writeEntries(file, entries);
    return entries;
  }
  if (command === 'sum') {
    const { month, file } = parseSumArgs(rest);
    const summary = summarize(readEntries(file), month);
    console.log(`income=${summary.income} expense=${summary.expense} balance=${summary.balance}`);
    return summary;
  }

  throw new TypeError(command === undefined ? USAGE : `unknown command: ${command}`);
}

const isDirect = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
