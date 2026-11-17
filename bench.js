#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');

const DEFAULTS = {
  runs: 10,
  timeoutMs: 60000,
  maxRedirects: 5,
};

function usage() {
  console.error(
    [
      'Usage: node bench.js <url> [options]',
      '',
      'Options:',
      `  --runs=<n>     Number of sequential requests (default: ${DEFAULTS.runs})`,
      '  --no-cache     Send anti-cache headers (on by default)',
      '',
      'Example:',
      '  node bench.js http://speedtest.tele2.net/100MB.zip',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS, url: null, noCache: true };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg.startsWith('--runs=')) {
      const n = Number.parseInt(arg.slice('--runs='.length), 10);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`Invalid --runs value: ${arg}`);
      }
      opts.runs = n;
    } else if (arg === '--no-cache') {
      opts.noCache = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!opts.url) {
      opts.url = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return opts;
}

function requestOnce(url, { timeoutMs, noCache, maxRedirects }, redirectsLeft = maxRedirects) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
    if (!lib) {
      reject(new Error(`Unsupported protocol: ${parsed.protocol}`));
      return;
    }

    const headers = {
      Host: parsed.host,
      Accept: '*/*',
      'User-Agent': 'bench.js/1.0',
      Connection: 'close',
    };
    if (noCache) {
      headers['Cache-Control'] = 'no-cache';
      headers.Pragma = 'no-cache';
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const req = lib.request(parsed, { method: 'GET', headers, agent: false }, (res) => {
      const status = res.statusCode || 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          finish(reject, new Error(`Too many redirects (last: ${url})`));
          return;
        }
        const next = new URL(res.headers.location, parsed).toString();
        requestOnce(next, { timeoutMs, noCache, maxRedirects }, redirectsLeft - 1)
          .then((v) => finish(resolve, v), (e) => finish(reject, e));
        return;
      }

      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
      });
      res.on('end', () => {
        finish(resolve, { status, bytes, url });
      });
      res.on('error', (e) => finish(reject, e));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs} ms`));
    });
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

function formatBytes(n) {
  return `${n} bytes (${(n / (1024 * 1024)).toFixed(2)} MiB)`;
}

function pad(value, width, align = 'left') {
  const s = String(value);
  if (s.length >= width) return s;
  const padLen = width - s.length;
  return align === 'right' ? ' '.repeat(padLen) + s : s + ' '.repeat(padLen);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}\n`);
    usage();
    process.exit(1);
  }

  if (!opts.url) {
    usage();
    process.exit(1);
  }

  try {
    const u = new URL(opts.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`Only http:// and https:// are supported, got: ${u.protocol}`);
    }
  } catch (err) {
    console.error(`Error: invalid URL "${opts.url}": ${err.message}`);
    process.exit(1);
  }

  console.log(`URL:      ${opts.url}`);
  console.log(`Requests: ${opts.runs} (sequential, cache: ${opts.noCache ? 'bypass' : 'default'})`);
  console.log('');

  const times = [];
  let totalBytes = 0;
  let totalTimeMs = 0;
  let failures = 0;
  let okStatus = true;

  (async () => {
    for (let i = 1; i <= opts.runs; i++) {
      const start = process.hrtime.bigint();
      try {
        const result = await requestOnce(opts.url, opts);
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

        times.push(elapsedMs);
        totalBytes += result.bytes;
        totalTimeMs += elapsedMs;

        if (result.status < 200 || result.status >= 300) {
          okStatus = false;
        }

        const line = [
          `#${pad(i, String(opts.runs).length)}`,
          `${pad(elapsedMs.toFixed(1), 10, 'right')} ms`,
          `${pad(result.bytes, 12, 'right')} bytes`,
          `HTTP ${result.status}`,
        ].join('  ');
        process.stdout.write(line + '\n');
      } catch (err) {
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
        failures++;
        const line = [
          `#${pad(i, String(opts.runs).length)}`,
          `${pad(elapsedMs.toFixed(1), 10, 'right')} ms`,
          `${pad('-', 12, 'right')}`,
          `ERROR: ${err.code ? `${err.code} ${err.message}`.trim() : err.message || 'unknown error'}`,
        ].join('  ');
        process.stdout.write(line + '\n');
      }
    }

    console.log('');

    if (times.length === 0) {
      console.error('All requests failed; no statistics available.');
      process.exit(1);
    }
    times.sort((a, b) => a - b);
    const avgMs = totalTimeMs / times.length;
    const minMs = times[0];
    const maxMs = times[times.length - 1];
    const medianMs = times.length % 2
      ? times[(times.length - 1) / 2]
      : (times[times.length / 2 - 1] + times[times.length / 2]) / 2;
    const speedMiBs = totalTimeMs > 0 ? totalBytes / (1024 * 1024) / (totalTimeMs / 1000) : 0;

    console.log(`Successful requests: ${times.length}/${opts.runs}${failures ? ` (${failures} failed)` : ''}`);
    console.log(`Total downloaded:     ${formatBytes(totalBytes)}`);
    console.log(`Total time:           ${(totalTimeMs / 1000).toFixed(3)} s`);
    console.log(`Request time:         avg ${avgMs.toFixed(2)} ms, min ${minMs.toFixed(2)} ms, max ${maxMs.toFixed(2)} ms, median ${medianMs.toFixed(2)} ms`);
    console.log(`Download speed:       ${speedMiBs.toFixed(2)} MiB/s (${(speedMiBs * 8).toFixed(2)} Mbit/s)`);

    if (failures > 0 || !okStatus) {
      process.exit(1);
    }
  })().catch((err) => {
    console.error(`Unexpected error: ${err.stack || err.message}`);
    process.exit(1);
  });
}

main();
