const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reed-migration-'));
  const old = path.join(root, 'old'); const data = path.join(root, 'Reed');
  const { protectKey, unprotectKey } = await import(pathToFileURL(path.resolve(__dirname, '../agent/endpoint.mjs')));
  await fs.mkdir(path.join(old, 'agent'), { recursive: true });
  const encrypted = await protectKey('isolated-migration-test-key');
  await fs.writeFile(path.join(old, 'agent/key.dpapi'), encrypted);
  const original = JSON.stringify({ version: 1, desktop: { theme: 'light', iconStyle: 'glass' }, sandbox: { readOnlyRoots: [path.join(old, 'skills'), 'D:\\external-notes'] } });
  await fs.writeFile(path.join(old, 'user-config.json'), original);
  const packageDir = await require('./isolated-package.cjs')(process.env.SUMMON_TEST_PACKAGE, root);
  let child;
  try {
    child = spawn(path.join(packageDir, 'Reed.exe'), [], { env: { ...process.env, SUMMON_TEST_DATA_DIR: data, SUMMON_TEST_LEGACY_DIR: old }, windowsHide: true });
    const deadline = Date.now() + 20000;
    while (true) {
      try { await fs.access(path.join(data, 'migration.json')); break; }
      catch { if (Date.now() > deadline) throw new Error('Native migration did not complete'); await new Promise(r => setTimeout(r, 100)); }
    }
    const copied = await fs.readFile(path.join(data, 'agent/key.dpapi'), 'utf8');
    assert.equal(copied, encrypted); assert.equal(await unprotectKey(copied), 'isolated-migration-test-key');
    assert.equal(await fs.readFile(path.join(old, 'user-config.json'), 'utf8'), original);
    const config = JSON.parse(await fs.readFile(path.join(data, 'user-config.json'), 'utf8'));
    assert.deepEqual(config.sandbox.readOnlyRoots, [path.join(data, 'skills'), 'D:\\external-notes']);
    console.log('PASS: native migration, DPAPI decryption, preserved backup and external paths');
  } finally {
    if (child?.pid && child.exitCode === null) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
