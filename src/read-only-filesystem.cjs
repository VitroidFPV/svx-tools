// The language worker has no reason to mutate real files. Generated TypeScript
// files use its separate in-memory System; edits are returned to the editor.
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');

function error(operation) {
  return Object.assign(new Error(`SVX language support cannot modify files (${operation})`), { code: 'EACCES' });
}
function reject(operation, args) {
  const callback = args.at(-1);
  if (typeof callback === 'function') process.nextTick(callback, error(operation));
  else throw error(operation);
}
for (const operation of ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'unlink', 'rename', 'rm', 'rmdir',
  'copyFile', 'cp', 'truncate', 'chmod', 'chown', 'lchmod', 'lchown', 'link', 'symlink', 'utimes', 'lutimes',
  'fchmod', 'fchown', 'futimes', 'ftruncate']) {
  if (fs[operation]) fs[operation] = (...args) => reject(operation, args);
  if (fs[`${operation}Sync`]) fs[`${operation}Sync`] = () => { throw error(operation); };
  if (fs.promises[operation]) fs.promises[operation] = async () => { throw error(operation); };
}
// Config factories may prepare build caches. Language support never runs those
// builds, so recursive cache-directory setup is a no-op in this worker.
fs.mkdirSync = (path, options) => { if (!options?.recursive) throw error('mkdir'); };
fs.mkdir = (path, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  if (options?.recursive) process.nextTick(done, null);
  else reject('mkdir', [path, done]);
};
fs.promises.mkdir = async (path, options) => { if (!options?.recursive) throw error('mkdir'); };
function writable(flags) {
  return typeof flags === 'number'
    ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : flags !== 'r' && flags !== 'rs';
}
const open = fs.open, openSync = fs.openSync, openPromise = fs.promises.open;
fs.open = (...args) => writable(args[1]) ? reject('open', args) : open(...args);
fs.openSync = (...args) => { if (writable(args[1])) throw error('open'); return openSync(...args); };
fs.promises.open = async (...args) => {
  if (writable(args[1] ?? 'r')) throw error('open');
  const handle = await openPromise(...args);
  for (const operation of ['write', 'writev', 'writeFile', 'appendFile', 'truncate', 'chmod', 'chown', 'utimes']) {
    handle[operation] = async () => { throw error(operation); };
  }
  handle.createWriteStream = () => { throw error('createWriteStream'); };
  return handle;
};
fs.createWriteStream = () => { throw error('createWriteStream'); };
syncBuiltinESMExports();
