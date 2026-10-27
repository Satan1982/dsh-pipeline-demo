import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addEntry, isValidDate } from './ledger.js';

const USAGE = 'usage: node src/ledger-cli.js add --date YYYY-MM-DD --amount N [--note TEXT] [--file PATH]';
const VALUE_FLAGS = new Set(['--date', '--amount', '--note', '--file']);

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

export function parseAddArgs(argv) {
  const args = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!VALUE_FLAGS.has(flag)) {
      throw new TypeError(`unknown argument: ${flag}`);
    }
    if (seen.has(flag)) {
      throw new TypeError(`duplicate argument: ${flag}`);
    }
    seen.add(flag);
    args[flag.slice(2)] = readValue(argv, i, flag);
    i += 1;
  }

  if (args.date === undefined) {
    throw new TypeError('--date is required');
  }
  if (!isValidDate(args.date)) {
    throw new TypeError('--date must be a valid YYYY-MM-DD date');
  }
  if (args.amount === undefined) {
    throw new TypeError('--amount is required');
  }

  const file = args.file ?? process.env.LEDGER_FILE ?? 'data/ledger.json';
  if (file.trim() === '') {
    throw new TypeError('--file must be a non-empty path');
  }

  return {
    date: args.date,
    amount: parseAmount(args.amount),
    note: args.note,
    file,
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
  if (command !== 'add') {
    throw new TypeError(command === undefined ? USAGE : `unknown command: ${command}`);
  }

  const { date, amount, note, file } = parseAddArgs(rest);
  const entries = addEntry(readEntries(file), { date, amount, note });
  writeEntries(file, entries);
  return entries;
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
