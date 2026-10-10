const fs = require('node:fs/promises');
const path = require('node:path');

// WebView2 profiles live beside the executable. Copy only the executable and
// link read-only dependencies so test instances cannot share a user's profile.
module.exports = async function isolatedPackage(source, data) {
  if (!source) throw new Error('SUMMON_TEST_PACKAGE is required');
  const target = path.join(data, 'package');
  await fs.mkdir(target);
  await fs.copyFile(path.join(source, 'Summon.exe'), path.join(target, 'Summon.exe'));
  for (const directory of ['agent', 'runtime']) {
    await fs.symlink(path.resolve(source, directory), path.join(target, directory), 'junction');
  }
  return target;
};
