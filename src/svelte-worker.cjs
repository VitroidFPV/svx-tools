// Owned integration with svelte-language-server 0.18.4 (MIT).
// Keep all dependency-specific access and lifecycle adaptation in this worker.
require('./read-only-filesystem.cjs');
const { createHash } = require('node:crypto');
const { readFileSync, statSync, realpathSync, existsSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { createRequire, Module } = require('node:module');
const { createMessageConnection } = require('vscode-jsonrpc/node.js');
const packagePath = require.resolve('svelte-language-server/package.json');
const upstream = join(dirname(packagePath), 'dist/src');
const servicePath = join(upstream, 'plugins/typescript/service.js');
const original = readFileSync(servicePath, 'utf8');
if (JSON.parse(readFileSync(packagePath, 'utf8')).version !== '0.18.4'
    || createHash('sha256').update(original).digest('hex') !== '35762e7a12df89015fb4c7f697161820d5261866f031a344b463068dacea556b') {
  throw new Error('Unsupported Svelte backend: update and validate the owned lifecycle adaptation');
}
// Upstream deleteSnapshot leaves the explicit virtual root registered. Removing
// it and scheduling synchronization is essential for a fresh close/reopen.
const adapted = original.replace('function deleteSnapshot(filePath) {', `function deleteSnapshot(filePath) {
        virtualDocuments.delete(filePath);
        scheduleUpdate(filePath);`) + `
exports.assignVirtualFile = (path, config) => configFileForOpenFiles.set(path, config);
exports.releaseProject = async key => {
    key = (0, utils_1.normalizePath)(key);
    const container = await services.get(key);
    container?.dispose();
    services.delete(key);
    parsedTsConfigInfo.delete(key);
    serviceSizeMap.delete(key);
    pendingReloads.delete(key);
    configFileModifiedTime.delete(key);
    for (const [path, dependents] of configPathToDependedProject.entries()) {
        dependents.delete(key);
        if (!dependents.size) {
            dependedConfigWatchers.get(path)?.close();
            dependedConfigWatchers.delete(path);
            configPathToDependedProject.delete(path);
            configFileModifiedTime.delete(path);
        }
    }
};`;
const load = createRequire(join(upstream, 'index.js'));
// Vite's default bundled loader writes a temporary module into the project.
// Use its in-memory module runner in our process instead.
const configLoaderPath = load.resolve('@sveltejs/load-config');
const configLoaderSource = readFileSync(configLoaderPath, 'utf8');
if (createHash('sha256').update(configLoaderSource).digest('hex') !== '4190f4027a3ae4da6ab47ad712ccc1f946bc1a0b0ef35e77b05cd2201f310179') {
  throw new Error('Unsupported Svelte config loader: validate the read-only Vite integration');
}
const configLoaderModule = new Module(configLoaderPath, module);
configLoaderModule.filename = configLoaderPath;
configLoaderModule.paths = Module._nodeModulePaths(dirname(configLoaderPath));
require.cache[configLoaderPath] = configLoaderModule;
configLoaderModule._compile(configLoaderSource.replace(
  "const resolved = await vite.resolveConfig({ root, configFile: configFilePath, logLevel: 'error' }, 'serve');", `
        const loaded = await vite.loadConfigFromFile({ command: 'serve', mode: 'development' }, configFilePath, root, 'error', undefined, 'runner');
        if (!loaded) return undefined;
        async function flatten(values) {
            const result = [];
            for (const value of values) {
                const plugin = await value;
                if (Array.isArray(plugin)) result.push(...await flatten(plugin));
                else if (plugin) result.push(plugin);
            }
            return result;
        }
        const plugins = await flatten(loaded.config.plugins ?? []);
        // SvelteKit exposes the language options when its factory is evaluated.
        // Do not resolve the full build pipeline, which generates project files.
        let resolved = { plugins };
        if (!plugins.some(plugin => plugin.name === 'vite-plugin-sveltekit-setup' && plugin.api?.options)) {
            resolved = await vite.resolveConfig({ ...loaded.config, root, configFile: false, logLevel: 'error',
                plugins: plugins.filter(plugin => plugin.name === 'vite-plugin-svelte:config') }, 'serve');
        }
    `), configLoaderPath);
configLoaderModule.loaded = true;

const serviceModule = new Module(servicePath, module);
serviceModule.filename = servicePath;
serviceModule.paths = Module._nodeModulePaths(dirname(servicePath));
require.cache[servicePath] = serviceModule;
serviceModule._compile(adapted, servicePath);
serviceModule.loaded = true;

const { Document, DocumentManager } = load('./lib/documents');
const { LSConfigManager } = load('./ls-config');
const { Logger } = load('./logger');
const { PluginHost, SveltePlugin, HTMLPlugin, CSSPlugin, TypeScriptPlugin, LSAndTSDocResolver } = load('./plugins');
const { FileSystemProvider } = load('./lib/FileSystemProvider');
const { createLanguageServices } = load('./plugins/css/service');
const ts = load('typescript');
const virtualFiles = new Map();
const missingLookups = new Map();
function recordMissing(path, isDirectory) {
  let directory = dirname(path);
  // Poll the closest existing ancestor: creating a file or directory changes
  // its parent. Grouping avoids probing thousands of failed package candidates.
  while (!missingLookups.has(directory) && !ts.sys.directoryExists(directory)
      && directory !== dirname(directory)) directory = dirname(directory);
  let entry = missingLookups.get(directory);
  if (!entry) {
    entry = { modified: modified(directory), paths: new Map() };
    missingLookups.set(directory, entry);
  }
  entry.paths.set(path, isDirectory);
}
const canonical = path => path.replaceAll('\\', '/');
const tsSystem = {
  ...ts.sys,
  writeFile(path, text) { virtualFiles.set(canonical(path), text); },
  readFile(path, encoding) { return virtualFiles.get(canonical(path)) ?? ts.sys.readFile(path, encoding); },
  fileExists(path) {
    const exists = virtualFiles.has(canonical(path)) || ts.sys.fileExists(path);
    if (!exists) recordMissing(path, false);
    return exists;
  },
  directoryExists(path) {
    const exists = ts.sys.directoryExists(path);
    if (!exists) recordMissing(path, true);
    return exists;
  }
};
Logger.setLogErrorsOnly(true);

const connection = createMessageConnection(process.stdin, process.stdout);
let documents, resolver, host, tsPlugin, sveltePlugin, workspace;
const opened = new Map();
const observedFiles = new Map();
const projects = new Map();
function modified(path) {
  try { return statSync(path).mtimeMs; } catch { return -1; }
}
function configFor(filename) {
  let directory = dirname(filename);
  const boundary = resolve(workspace);
  while (true) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const path = join(directory, name);
      if (existsSync(path)) return realpathSync(path);
    }
    if (directory === boundary || directory === dirname(directory)) break;
    directory = dirname(directory);
  }
}
connection.onRequest('initialize', ({ workspaceRoot }) => {
  workspace = workspaceRoot;
  const uris = [pathToFileURL(workspace).href];
  const folders = [{ name: 'SVX', uri: uris[0] }];
  documents = new DocumentManager(item => new Document(item.uri, item.text));
  const config = new LSConfigManager();
  const hints = { inlayHints: {
    variableTypes: { enabled: true }, functionLikeReturnTypes: { enabled: true },
    parameterTypes: { enabled: true }, propertyDeclarationTypes: { enabled: true }
  } };
  config.updateTsJsUserPreferences({ typescript: hints, javascript: hints });
  resolver = new LSAndTSDocResolver(documents, uris, config, {
    tsSystem,
    watch: true,
    onFileSnapshotCreated(path) {
      if (!path.includes('/node_modules/')) observedFiles.set(path, modified(path));
    }
  });
  host = new PluginHost(documents);
  host.initialize({ filterIncompleteCompletions: true, definitionLinkSupport: true });
  sveltePlugin = new SveltePlugin(config);
  tsPlugin = new TypeScriptPlugin(config, resolver, uris, documents);
  const fs = new FileSystemProvider();
  host.register(sveltePlugin);
  host.register(new HTMLPlugin(documents, config, fs, folders));
  host.register(new CSSPlugin(documents, config, folders, createLanguageServices({ fileSystemProvider: fs })));
  host.register(tsPlugin);
  return null;
});

async function refreshFiles() {
  const changed = new Set();
  // Failed resolutions also need refreshing. TypeScript can skip all file
  // probes under an absent directory, so discover its files when it appears.
  for (const [directory, entry] of [...missingLookups]) {
    if (modified(directory) === entry.modified) continue;
    missingLookups.delete(directory);
    for (const [path, isDirectory] of entry.paths) {
      const exists = isDirectory ? ts.sys.directoryExists(path) : tsSystem.fileExists(path);
      if (!exists) {
        if (isDirectory) recordMissing(path, true);
        continue;
      }
      if (isDirectory) {
        for (const file of ts.sys.readDirectory(path, undefined, undefined, ['**/*'])) changed.add(file);
      } else changed.add(path);
    }
  }
  for (const [path, before] of observedFiles) {
    const after = modified(path);
    if (after === before) continue;
    changed.add(path);
    observedFiles.set(path, after);
    if (after === -1) {
      await resolver.deleteSnapshot(path);
      continue;
    }
    if (path.endsWith('.svelte')) await resolver.updateExistingSvelteFile(path);
    else await resolver.updateExistingTsOrJsFile(path);
  }
  if (changed.size) await resolver.invalidateModuleCache([...changed]);
}
async function register(uri, text) {
  const path = fileURLToPath(uri);
  const config = configFor(path);
  const key = config ?? workspace;
  if (opened.has(uri) && opened.get(uri).key !== key) {
    await resolver.deleteSnapshot(path);
    opened.delete(uri);
  }
  const container = config
    ? await resolver.getTSServiceByConfigPath(config, dirname(config))
    : await resolver.getTSServiceByConfigPath('', workspace);
  // Register first in a configured service, then subsequent resolver calls see
  // this exact project assignment rather than an inferred-file fallback.
  serviceModule.exports.assignVirtualFile(path.replaceAll('\\', '/'), container.tsconfigPath || workspace);
  const previous = documents.get(uri);
  const document = previous?.getText() === text ? previous : documents.openClientDocument({ uri, text });
  container.openVirtualDocument(document);
  projects.set(key, container);
  opened.set(uri, { text, key });
  return { document, container };
}
connection.onRequest('sync', async ({ uri, text }) => {
  await register(uri, text);
  await retireProjects();
  return null;
});
connection.onRequest('operation', async ({ uri, method, position, range }) => {
  const entry = opened.get(uri);
  if (!entry) throw new Error('Operation on a closed virtual document');
  await refreshFiles();
  // A config watcher may have replaced the container. Restore every live root
  // in this project before requesting anything from the replacement service.
  let current;
  for (const [otherUri, other] of opened) {
    if (other.key === entry.key) {
      const registered = await register(otherUri, other.text);
      if (otherUri === uri) current = registered;
    }
  }
  await retireProjects();
  const { document, container } = current;
  if (method === 'diagnostics') {
    if (!container.getService().getProgram()?.getSourceFile(fileURLToPath(uri))) {
      throw new Error('Virtual document missing from its TypeScript program: ' + uri);
    }
    // Direct providers propagate failures; PluginHost otherwise catches and
    // converts backend exceptions into empty successful diagnostic results.
    return [...await sveltePlugin.getDiagnostics(document), ...await tsPlugin.getDiagnostics(document)];
  }
  if (method === 'hover') return host.doHover({ uri }, position);
  if (method === 'completion') return host.getCompletions({ uri }, position);
  if (method === 'definition') return host.getDefinitions({ uri }, position);
  if (method === 'inlayHint') return host.getInlayHints({ uri }, range);
  throw new Error('Unknown operation: ' + method);
});
connection.onRequest('close', async ({ uri }) => {
  if (!opened.delete(uri)) return null;
  await resolver.deleteSnapshot(fileURLToPath(uri));
  observedFiles.delete(fileURLToPath(uri));
  const path = fileURLToPath(uri);
  for (const [directory, entry] of missingLookups) {
    for (const missing of entry.paths.keys()) {
      if (missing === path || missing.startsWith(path + '.')) entry.paths.delete(missing);
    }
    if (!entry.paths.size) missingLookups.delete(directory);
  }
  // deleteSnapshot also closes and releases the DocumentManager entry.
  await retireProjects();
  return null;
});
async function retireProjects() {
  const live = new Set([...opened.values()].map(entry => entry.key));
  let retired = false;
  for (const key of projects.keys()) {
    if (live.has(key)) continue;
    await serviceModule.exports.releaseProject(key);
    projects.delete(key);
    retired = true;
  }
  if (!retired) return;
  // Global snapshots are shared: keep dependencies actually used by another
  // live program, then release the retired project's remaining snapshots/docs.
  const needed = new Set();
  await serviceModule.exports.forAllServices(container => {
    for (const file of container.getService().getProgram()?.getSourceFiles() ?? []) needed.add(file.fileName);
  });
  for (const snapshot of resolver.globalSnapshotsManager.getByPrefix('')) {
    if (needed.has(snapshot.filePath)) continue;
    await resolver.deleteSnapshot(snapshot.filePath);
    observedFiles.delete(snapshot.filePath);
  }
  for (const path of virtualFiles.keys()) if (!needed.has(path)) virtualFiles.delete(path);
}
connection.onRequest('inspect', async ({ gc = false } = {}) => {
  if (gc) global.gc?.();
  const services = [];
  await serviceModule.exports.forAllServices(container => {
    const program = container.getService().getProgram();
    const dependencies = new Map();
    for (const file of program?.getSourceFiles() ?? []) {
      if (!file.fileName.includes('/node_modules/')) continue;
      const parts = file.fileName.split('/node_modules/').at(-1).split('/');
      const name = parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/');
      dependencies.set(name, (dependencies.get(name) ?? 0) + 1);
    }
    services.push({ config: container.tsconfigPath || workspace, roots: program?.getRootFileNames(),
      files: program?.getSourceFiles().length,
      dependencies: [...dependencies].sort((a, b) => b[1] - a[1]).map(([name, files]) => ({ name, files })) });
  });
  return { pid: process.pid, memory: process.memoryUsage(), peakRssMiB: process.resourceUsage().maxRSS / 1024, projects: services };
});
connection.onRequest('shutdown', async () => {
  await serviceModule.exports.forAllServices(service => service.dispose());
  setImmediate(() => process.exit(0));
  return null;
});
// EOF and parent death release all upstream module caches, watchers and timers.
process.stdin.on('end', () => process.exit(0));
connection.listen();
