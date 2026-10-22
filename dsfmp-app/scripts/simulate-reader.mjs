#!/usr/bin/env node
// ============================================================
// DSFMP NFC reader simulator
//
// Stands in for the ESP32 reader until the hardware arrives. It sends
// the same HTTP request the firmware will send for each card tap:
//
//   POST {SUPABASE_URL}/rest/v1/rpc/record_nfc_scan
//   apikey: {anon key}
//   { "p_nfc_tag_id": ..., "p_device_id": ..., "p_mode": ..., ... }
//
// and prints each result with its round-trip time, then a summary
// (successes, errors by type, min/avg/p95/max latency).
//
// Examples (run from dsfmp-app/):
//   npm run simulate -- --device reader-tumaini-01 --tag A1000001
//   npm run simulate -- --device reader-tumaini-01 --tag A1000001,A1000002,A1000003
//   npm run simulate -- --device reader-baraka-01 --tag C3000001 --repeat 20 --interval 500
//   npm run simulate -- --device reader-upendo-01 --tag B2000001 \
//       --mode distribution --item <inventory item uuid> --quantity 0.25
//
// Every scan is real: it writes to the database the app uses, exactly
// as a card tap on the reader would.
// ============================================================

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const HELP = `Usage: npm run simulate -- --device <device id> --tag <card id>[,<card id>...] [options]

  --device <id>       Registered reader ID, e.g. reader-tumaini-01 (required)
  --tag <ids>         Card ID(s) to tap, comma separated (required)
  --mode <mode>       attendance (default) or distribution
  --item <uuid>       Inventory item ID (required for distribution)
  --quantity <n>      Quantity issued per tap (default 1)
  --repeat <n>        Tap the whole list of cards n times (default 1)
  --interval <ms>     Pause between taps in milliseconds (default 0)
  --json              Print one JSON line per tap instead of text
  --help              Show this message

Supabase URL and anon key are read from SUPABASE_URL and SUPABASE_ANON_KEY,
or from src/lib/supabase.ts if those are not set.`;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      device: { type: 'string' },
      tag: { type: 'string' },
      mode: { type: 'string', default: 'attendance' },
      item: { type: 'string' },
      quantity: { type: 'string', default: '1' },
      repeat: { type: 'string', default: '1' },
      interval: { type: 'string', default: '0' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  }));
} catch (err) {
  fail(err.message);
}

if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (!args.device || !args.tag) fail('--device and --tag are required.');

const tags = args.tag.split(',').map((t) => t.trim()).filter(Boolean);
const quantity = Number(args.quantity);
const repeat = Number(args.repeat);
const interval = Number(args.interval);
if (!Number.isInteger(repeat) || repeat < 1) fail('--repeat must be a whole number of at least 1.');
if (!Number.isFinite(interval) || interval < 0) fail('--interval must be 0 or more.');
// Mode, item and quantity are not checked here on purpose: the database
// validates them, and the simulator should be able to send bad input
// the way a misconfigured reader could.

const { url, key } = loadConfig();
const endpoint = `${url}/rest/v1/rpc/record_nfc_scan`;

const results = [];
const total = tags.length * repeat;
for (let round = 0; round < repeat; round++) {
  for (const tag of tags) {
    if (results.length > 0 && interval > 0) await sleep(interval);
    const result = await scan(tag);
    results.push(result);
    report(result, results.length, total);
  }
}
if (!args.json) summarise(results);

// ------------------------------------------------------------

async function scan(tag) {
  const body = {
    p_nfc_tag_id: tag,
    p_device_id: args.device,
    p_mode: args.mode,
    p_quantity: quantity,
  };
  if (args.item) body.p_item_id = args.item;

  const started = performance.now();
  let status = 0;
  let response;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    status = res.status;
    const text = await res.text();
    try {
      response = JSON.parse(text);
    } catch {
      response = { message: text };
    }
  } catch (err) {
    response = { message: err.cause?.message ?? err.message };
  }
  const ms = performance.now() - started;

  // A 200 carries the function's own { success, error, first_name } result;
  // anything else is an HTTP or network failure before the function ran.
  if (status === 200) {
    return { tag, ms, success: response.success === true, error: response.error ?? null, name: response.first_name ?? null };
  }
  const error = status === 0 ? 'network_error' : `http_${status}`;
  return { tag, ms, success: false, error, detail: response.message ?? JSON.stringify(response) };
}

function report(r, n, total) {
  if (args.json) {
    console.log(JSON.stringify({ at: new Date().toISOString(), device: args.device, mode: args.mode, ...r, ms: round1(r.ms) }));
    return;
  }
  const counter = `[${String(n).padStart(String(total).length)}/${total}]`;
  const outcome = r.success
    ? `OK      ${r.name ?? ''} - ${args.mode === 'distribution' ? 'food issued' : 'attendance recorded'}`
    : `FAILED  ${r.error}${r.detail ? ` (${r.detail})` : ''}`;
  console.log(`${counter} ${r.tag.padEnd(10)} ${outcome.padEnd(48)} ${round1(r.ms)} ms`);
}

function summarise(results) {
  const ok = results.filter((r) => r.success).length;
  const errors = {};
  for (const r of results) if (!r.success) errors[r.error] = (errors[r.error] ?? 0) + 1;
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const p95 = times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)];

  console.log('');
  console.log(`Taps:     ${results.length}  (${ok} succeeded, ${results.length - ok} failed)`);
  for (const [error, count] of Object.entries(errors)) console.log(`          ${error}: ${count}`);
  console.log(`Latency:  min ${round1(times[0])} ms, avg ${round1(avg)} ms, p95 ${round1(p95)} ms, max ${round1(times.at(-1))} ms`);
}

function loadConfig() {
  let url = process.env.SUPABASE_URL;
  let key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    // Fall back to the values the app itself uses.
    try {
      const source = readFileSync(new URL('../src/lib/supabase.ts', import.meta.url), 'utf8');
      url ??= source.match(/SUPABASE_URL\s*=\s*['"]([^'"]+)['"]/)?.[1];
      key ??= source.match(/SUPABASE_ANON_KEY\s*=\s*['"]([^'"]+)['"]/)?.[1];
    } catch {
      // handled below
    }
  }
  if (!url || !key) fail('Set SUPABASE_URL and SUPABASE_ANON_KEY (Supabase Dashboard > Project Settings > API).');
  return { url: url.replace(/\/+$/, ''), key };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function fail(message) {
  console.error(`${message}\n\n${HELP}`);
  process.exit(1);
}
