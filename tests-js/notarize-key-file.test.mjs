import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'vitest'

// Both entry points run in their own process against the real filesystem. Only
// Apple's binaries are stand-ins: `xcrun notarytool` records the key file it was
// handed and that file's mode, then reports an accepted submission.
function runNotary(entry, collision) {
  const dir = mkdtempSync(join(tmpdir(), 'notary-key-file-test-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  mkdirSync(join(dir, 'Fixture.app'))
  const artifact = join(dir, 'fixture.dmg')
  writeFileSync(artifact, 'synthetic artifact')
  const receipt = join(dir, 'receipt.json')

  for (const name of ['ditto', 'xcrun']) {
    writeFileSync(
      join(bin, name),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'notarytool') {
  const key = args[args.indexOf('--key') + 1];
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ key, mode: fs.statSync(key).mode & 0o777 }));
  process.stdout.write(JSON.stringify({ id: 'fixture-submission', status: 'Accepted' }));
}
`,
      { mode: 0o700 }
    )
  }

  const script = new URL(entry, import.meta.url).href
  const victim = join(dir, 'existing-file')
  const driver = join(dir, 'driver.mjs')
  // A permissive umask and a fixed clock make the key path predictable, so the
  // collision case can plant a symlink exactly where the key would be written.
  writeFileSync(
    driver,
    `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.umask(0);
Date.now = () => 123456;
if (${collision}) {
  fs.writeFileSync(${JSON.stringify(victim)}, 'preserve this');
  fs.symlinkSync(${JSON.stringify(victim)}, path.join(os.tmpdir(), 'hermes-notary-123456-' + process.pid + '.p8'));
}
${
  entry.endsWith('/notarize.mjs')
    ? `await (await import(${JSON.stringify(script)})).default({ electronPlatformName: 'darwin', appOutDir: ${JSON.stringify(dir)}, packager: { appInfo: { productFilename: 'Fixture' } } });`
    : `process.argv[2] = ${JSON.stringify(artifact)}; await import(${JSON.stringify(script)});`
}
`
  )

  const result = spawnSync(process.execPath, [driver], {
    env: {
      PATH: bin,
      TMPDIR: dir,
      APPLE_NOTARY_PROFILE: '',
      APPLE_API_KEY: '-----BEGIN PRIVATE KEY-----\nSYNTHETIC ONLY\n-----END PRIVATE KEY-----',
      APPLE_API_KEY_ID: 'fixture-id',
      APPLE_API_ISSUER: 'fixture-issuer'
    },
    encoding: 'utf8',
    timeout: 10_000
  })

  return { dir, receipt, result, victim }
}

describe.skipIf(process.platform === 'win32')('inline notarization key file', () => {
  for (const entry of ['../apps/desktop/scripts/notarize.mjs', '../apps/desktop/scripts/notarize-artifact.mjs']) {
    test(`${entry.split('/').pop()}: the key file is owner-only while notarytool reads it and removed afterwards`, () => {
      const { dir, receipt, result } = runNotary(entry, false)

      try {
        assert.equal(result.status, 0, result.stderr)
        const observed = JSON.parse(readFileSync(receipt, 'utf8'))
        assert.equal(observed.mode, 0o600)
        assert.equal(existsSync(observed.key), false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test(`${entry.split('/').pop()}: a file already at the key path is never written through`, () => {
      const { dir, receipt, result, victim } = runNotary(entry, true)

      try {
        assert.equal(readFileSync(victim, 'utf8'), 'preserve this')
        assert.notEqual(result.status, 0)
        assert.equal(existsSync(receipt), false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
