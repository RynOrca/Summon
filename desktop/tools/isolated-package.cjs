const fs = require('node:fs/promises');
const path = require('node:path');

// Copy the executable and link read-only dependencies. SUMMON_TEST_DATA_DIR
// isolates WebView2, configuration and window state from the user profile.
module.exports = async function isolatedPackage(source, data) {
  if (!source) throw new Error('SUMMON_TEST_PACKAGE is required');
  const target = path.join(data, 'package');
  await fs.mkdir(target);
  await fs.copyFile(path.join(source, 'Reed.exe'), path.join(target, 'Reed.exe'));
  await fs.mkdir(path.join(target, 'runtime'));
  await fs.copyFile(path.join(source, 'runtime/node.exe'), path.join(target, 'runtime/node.exe'));
  for (const directory of ['agent']) {
    await fs.symlink(path.resolve(source, directory), path.join(target, directory), 'junction');
  }
  return target;
};
