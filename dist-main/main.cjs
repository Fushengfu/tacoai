"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/dotenv/package.json
var require_package = __commonJS({
  "node_modules/dotenv/package.json"(exports2, module2) {
    module2.exports = {
      name: "dotenv",
      version: "16.6.1",
      description: "Loads environment variables from .env file",
      main: "lib/main.js",
      types: "lib/main.d.ts",
      exports: {
        ".": {
          types: "./lib/main.d.ts",
          require: "./lib/main.js",
          default: "./lib/main.js"
        },
        "./config": "./config.js",
        "./config.js": "./config.js",
        "./lib/env-options": "./lib/env-options.js",
        "./lib/env-options.js": "./lib/env-options.js",
        "./lib/cli-options": "./lib/cli-options.js",
        "./lib/cli-options.js": "./lib/cli-options.js",
        "./package.json": "./package.json"
      },
      scripts: {
        "dts-check": "tsc --project tests/types/tsconfig.json",
        lint: "standard",
        pretest: "npm run lint && npm run dts-check",
        test: "tap run --allow-empty-coverage --disable-coverage --timeout=60000",
        "test:coverage": "tap run --show-full-coverage --timeout=60000 --coverage-report=text --coverage-report=lcov",
        prerelease: "npm test",
        release: "standard-version"
      },
      repository: {
        type: "git",
        url: "git://github.com/motdotla/dotenv.git"
      },
      homepage: "https://github.com/motdotla/dotenv#readme",
      funding: "https://dotenvx.com",
      keywords: [
        "dotenv",
        "env",
        ".env",
        "environment",
        "variables",
        "config",
        "settings"
      ],
      readmeFilename: "README.md",
      license: "BSD-2-Clause",
      devDependencies: {
        "@types/node": "^18.11.3",
        decache: "^4.6.2",
        sinon: "^14.0.1",
        standard: "^17.0.0",
        "standard-version": "^9.5.0",
        tap: "^19.2.0",
        typescript: "^4.8.4"
      },
      engines: {
        node: ">=12"
      },
      browser: {
        fs: false
      }
    };
  }
});

// node_modules/dotenv/lib/main.js
var require_main = __commonJS({
  "node_modules/dotenv/lib/main.js"(exports2, module2) {
    var fs7 = require("fs");
    var path8 = require("path");
    var os = require("os");
    var crypto = require("crypto");
    var packageJson = require_package();
    var version = packageJson.version;
    var LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
    function parse(src) {
      const obj = {};
      let lines = src.toString();
      lines = lines.replace(/\r\n?/mg, "\n");
      let match;
      while ((match = LINE.exec(lines)) != null) {
        const key = match[1];
        let value = match[2] || "";
        value = value.trim();
        const maybeQuote = value[0];
        value = value.replace(/^(['"`])([\s\S]*)\1$/mg, "$2");
        if (maybeQuote === '"') {
          value = value.replace(/\\n/g, "\n");
          value = value.replace(/\\r/g, "\r");
        }
        obj[key] = value;
      }
      return obj;
    }
    function _parseVault(options) {
      options = options || {};
      const vaultPath = _vaultPath(options);
      options.path = vaultPath;
      const result = DotenvModule.configDotenv(options);
      if (!result.parsed) {
        const err = new Error(`MISSING_DATA: Cannot parse ${vaultPath} for an unknown reason`);
        err.code = "MISSING_DATA";
        throw err;
      }
      const keys = _dotenvKey(options).split(",");
      const length = keys.length;
      let decrypted;
      for (let i = 0; i < length; i++) {
        try {
          const key = keys[i].trim();
          const attrs = _instructions(result, key);
          decrypted = DotenvModule.decrypt(attrs.ciphertext, attrs.key);
          break;
        } catch (error) {
          if (i + 1 >= length) {
            throw error;
          }
        }
      }
      return DotenvModule.parse(decrypted);
    }
    function _warn(message) {
      console.log(`[dotenv@${version}][WARN] ${message}`);
    }
    function _debug(message) {
      console.log(`[dotenv@${version}][DEBUG] ${message}`);
    }
    function _log(message) {
      console.log(`[dotenv@${version}] ${message}`);
    }
    function _dotenvKey(options) {
      if (options && options.DOTENV_KEY && options.DOTENV_KEY.length > 0) {
        return options.DOTENV_KEY;
      }
      if (process.env.DOTENV_KEY && process.env.DOTENV_KEY.length > 0) {
        return process.env.DOTENV_KEY;
      }
      return "";
    }
    function _instructions(result, dotenvKey) {
      let uri;
      try {
        uri = new URL(dotenvKey);
      } catch (error) {
        if (error.code === "ERR_INVALID_URL") {
          const err = new Error("INVALID_DOTENV_KEY: Wrong format. Must be in valid uri format like dotenv://:key_1234@dotenvx.com/vault/.env.vault?environment=development");
          err.code = "INVALID_DOTENV_KEY";
          throw err;
        }
        throw error;
      }
      const key = uri.password;
      if (!key) {
        const err = new Error("INVALID_DOTENV_KEY: Missing key part");
        err.code = "INVALID_DOTENV_KEY";
        throw err;
      }
      const environment = uri.searchParams.get("environment");
      if (!environment) {
        const err = new Error("INVALID_DOTENV_KEY: Missing environment part");
        err.code = "INVALID_DOTENV_KEY";
        throw err;
      }
      const environmentKey = `DOTENV_VAULT_${environment.toUpperCase()}`;
      const ciphertext = result.parsed[environmentKey];
      if (!ciphertext) {
        const err = new Error(`NOT_FOUND_DOTENV_ENVIRONMENT: Cannot locate environment ${environmentKey} in your .env.vault file.`);
        err.code = "NOT_FOUND_DOTENV_ENVIRONMENT";
        throw err;
      }
      return { ciphertext, key };
    }
    function _vaultPath(options) {
      let possibleVaultPath = null;
      if (options && options.path && options.path.length > 0) {
        if (Array.isArray(options.path)) {
          for (const filepath of options.path) {
            if (fs7.existsSync(filepath)) {
              possibleVaultPath = filepath.endsWith(".vault") ? filepath : `${filepath}.vault`;
            }
          }
        } else {
          possibleVaultPath = options.path.endsWith(".vault") ? options.path : `${options.path}.vault`;
        }
      } else {
        possibleVaultPath = path8.resolve(process.cwd(), ".env.vault");
      }
      if (fs7.existsSync(possibleVaultPath)) {
        return possibleVaultPath;
      }
      return null;
    }
    function _resolveHome(envPath) {
      return envPath[0] === "~" ? path8.join(os.homedir(), envPath.slice(1)) : envPath;
    }
    function _configVault(options) {
      const debug = Boolean(options && options.debug);
      const quiet = options && "quiet" in options ? options.quiet : true;
      if (debug || !quiet) {
        _log("Loading env from encrypted .env.vault");
      }
      const parsed = DotenvModule._parseVault(options);
      let processEnv = process.env;
      if (options && options.processEnv != null) {
        processEnv = options.processEnv;
      }
      DotenvModule.populate(processEnv, parsed, options);
      return { parsed };
    }
    function configDotenv(options) {
      const dotenvPath = path8.resolve(process.cwd(), ".env");
      let encoding = "utf8";
      const debug = Boolean(options && options.debug);
      const quiet = options && "quiet" in options ? options.quiet : true;
      if (options && options.encoding) {
        encoding = options.encoding;
      } else {
        if (debug) {
          _debug("No encoding is specified. UTF-8 is used by default");
        }
      }
      let optionPaths = [dotenvPath];
      if (options && options.path) {
        if (!Array.isArray(options.path)) {
          optionPaths = [_resolveHome(options.path)];
        } else {
          optionPaths = [];
          for (const filepath of options.path) {
            optionPaths.push(_resolveHome(filepath));
          }
        }
      }
      let lastError;
      const parsedAll = {};
      for (const path9 of optionPaths) {
        try {
          const parsed = DotenvModule.parse(fs7.readFileSync(path9, { encoding }));
          DotenvModule.populate(parsedAll, parsed, options);
        } catch (e) {
          if (debug) {
            _debug(`Failed to load ${path9} ${e.message}`);
          }
          lastError = e;
        }
      }
      let processEnv = process.env;
      if (options && options.processEnv != null) {
        processEnv = options.processEnv;
      }
      DotenvModule.populate(processEnv, parsedAll, options);
      if (debug || !quiet) {
        const keysCount = Object.keys(parsedAll).length;
        const shortPaths = [];
        for (const filePath of optionPaths) {
          try {
            const relative = path8.relative(process.cwd(), filePath);
            shortPaths.push(relative);
          } catch (e) {
            if (debug) {
              _debug(`Failed to load ${filePath} ${e.message}`);
            }
            lastError = e;
          }
        }
        _log(`injecting env (${keysCount}) from ${shortPaths.join(",")}`);
      }
      if (lastError) {
        return { parsed: parsedAll, error: lastError };
      } else {
        return { parsed: parsedAll };
      }
    }
    function config(options) {
      if (_dotenvKey(options).length === 0) {
        return DotenvModule.configDotenv(options);
      }
      const vaultPath = _vaultPath(options);
      if (!vaultPath) {
        _warn(`You set DOTENV_KEY but you are missing a .env.vault file at ${vaultPath}. Did you forget to build it?`);
        return DotenvModule.configDotenv(options);
      }
      return DotenvModule._configVault(options);
    }
    function decrypt(encrypted, keyStr) {
      const key = Buffer.from(keyStr.slice(-64), "hex");
      let ciphertext = Buffer.from(encrypted, "base64");
      const nonce = ciphertext.subarray(0, 12);
      const authTag = ciphertext.subarray(-16);
      ciphertext = ciphertext.subarray(12, -16);
      try {
        const aesgcm = crypto.createDecipheriv("aes-256-gcm", key, nonce);
        aesgcm.setAuthTag(authTag);
        return `${aesgcm.update(ciphertext)}${aesgcm.final()}`;
      } catch (error) {
        const isRange = error instanceof RangeError;
        const invalidKeyLength = error.message === "Invalid key length";
        const decryptionFailed = error.message === "Unsupported state or unable to authenticate data";
        if (isRange || invalidKeyLength) {
          const err = new Error("INVALID_DOTENV_KEY: It must be 64 characters long (or more)");
          err.code = "INVALID_DOTENV_KEY";
          throw err;
        } else if (decryptionFailed) {
          const err = new Error("DECRYPTION_FAILED: Please check your DOTENV_KEY");
          err.code = "DECRYPTION_FAILED";
          throw err;
        } else {
          throw error;
        }
      }
    }
    function populate(processEnv, parsed, options = {}) {
      const debug = Boolean(options && options.debug);
      const override = Boolean(options && options.override);
      if (typeof parsed !== "object") {
        const err = new Error("OBJECT_REQUIRED: Please check the processEnv argument being passed to populate");
        err.code = "OBJECT_REQUIRED";
        throw err;
      }
      for (const key of Object.keys(parsed)) {
        if (Object.prototype.hasOwnProperty.call(processEnv, key)) {
          if (override === true) {
            processEnv[key] = parsed[key];
          }
          if (debug) {
            if (override === true) {
              _debug(`"${key}" is already defined and WAS overwritten`);
            } else {
              _debug(`"${key}" is already defined and was NOT overwritten`);
            }
          }
        } else {
          processEnv[key] = parsed[key];
        }
      }
    }
    var DotenvModule = {
      configDotenv,
      _configVault,
      _parseVault,
      config,
      decrypt,
      parse,
      populate
    };
    module2.exports.configDotenv = DotenvModule.configDotenv;
    module2.exports._configVault = DotenvModule._configVault;
    module2.exports._parseVault = DotenvModule._parseVault;
    module2.exports.config = DotenvModule.config;
    module2.exports.decrypt = DotenvModule.decrypt;
    module2.exports.parse = DotenvModule.parse;
    module2.exports.populate = DotenvModule.populate;
    module2.exports = DotenvModule;
  }
});

// node_modules/dotenv/lib/env-options.js
var require_env_options = __commonJS({
  "node_modules/dotenv/lib/env-options.js"(exports2, module2) {
    var options = {};
    if (process.env.DOTENV_CONFIG_ENCODING != null) {
      options.encoding = process.env.DOTENV_CONFIG_ENCODING;
    }
    if (process.env.DOTENV_CONFIG_PATH != null) {
      options.path = process.env.DOTENV_CONFIG_PATH;
    }
    if (process.env.DOTENV_CONFIG_QUIET != null) {
      options.quiet = process.env.DOTENV_CONFIG_QUIET;
    }
    if (process.env.DOTENV_CONFIG_DEBUG != null) {
      options.debug = process.env.DOTENV_CONFIG_DEBUG;
    }
    if (process.env.DOTENV_CONFIG_OVERRIDE != null) {
      options.override = process.env.DOTENV_CONFIG_OVERRIDE;
    }
    if (process.env.DOTENV_CONFIG_DOTENV_KEY != null) {
      options.DOTENV_KEY = process.env.DOTENV_CONFIG_DOTENV_KEY;
    }
    module2.exports = options;
  }
});

// node_modules/dotenv/lib/cli-options.js
var require_cli_options = __commonJS({
  "node_modules/dotenv/lib/cli-options.js"(exports2, module2) {
    var re = /^dotenv_config_(encoding|path|quiet|debug|override|DOTENV_KEY)=(.+)$/;
    module2.exports = function optionMatcher(args) {
      const options = args.reduce(function(acc, cur) {
        const matches = cur.match(re);
        if (matches) {
          acc[matches[1]] = matches[2];
        }
        return acc;
      }, {});
      if (!("quiet" in options)) {
        options.quiet = "true";
      }
      return options;
    };
  }
});

// src/main/notes.ts
var notes_exports = {};
__export(notes_exports, {
  deleteNote: () => deleteNote,
  getNotesPromptBlock: () => getNotesPromptBlock,
  listNotes: () => listNotes,
  saveNote: () => saveNote
});
function workspaceHash(workspace) {
  return (0, import_node_crypto2.createHash)("sha256").update(import_node_path3.default.resolve(workspace)).digest("hex").slice(0, 16);
}
function projectScope(projectId) {
  return "project-" + (0, import_node_crypto2.createHash)("sha256").update(projectId).digest("hex").slice(0, 16);
}
function resolveScope(workspace, projectId) {
  if (projectId && projectId.trim()) return projectScope(projectId.trim());
  if (workspace && workspace.trim()) return workspaceHash(workspace);
  return "global";
}
function notesFilePath(workspace, projectId) {
  return import_node_path3.default.join(NOTES_DIR, `${resolveScope(workspace, projectId)}.json`);
}
async function ensureDir() {
  await import_promises.default.mkdir(NOTES_DIR, { recursive: true });
}
async function loadNotes(workspace, projectId) {
  const primaryPath = notesFilePath(workspace, projectId);
  try {
    const raw = await import_promises.default.readFile(primaryPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    if (projectId && workspace && workspace.trim()) {
      try {
        const legacyRaw = await import_promises.default.readFile(notesFilePath(workspace), "utf-8");
        return JSON.parse(legacyRaw);
      } catch {
        return [];
      }
    }
    return [];
  }
}
async function saveNotes(workspace, notes, projectId) {
  await ensureDir();
  const filePath = notesFilePath(workspace, projectId);
  await import_promises.default.writeFile(filePath, JSON.stringify(notes, null, 2), "utf-8");
}
async function listNotes(workspace, projectId) {
  return loadNotes(workspace, projectId);
}
async function saveNote(workspace, note, projectId) {
  const notes = await loadNotes(workspace, projectId);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const existIdx = notes.findIndex((n) => n.id === note.id);
  if (existIdx >= 0) {
    notes[existIdx] = { ...note, updatedAt: now };
  } else {
    notes.push({ ...note, createdAt: now, updatedAt: now });
  }
  await saveNotes(workspace, notes, projectId);
  return existIdx >= 0 ? notes[existIdx] : notes[notes.length - 1];
}
async function deleteNote(workspace, noteId, projectId) {
  const notes = await loadNotes(workspace, projectId);
  const filtered = notes.filter((n) => n.id !== noteId);
  await saveNotes(workspace, filtered, projectId);
}
async function getNotesPromptBlock(workspace, projectId) {
  const notes = await loadNotes(workspace, projectId);
  if (notes.length === 0) return "";
  const grouped = /* @__PURE__ */ new Map();
  for (const note of notes) {
    const cat = note.category || "other";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(note);
  }
  const blocks = [];
  for (const [cat, catNotes] of grouped) {
    const label = CATEGORY_LABELS[cat] || cat;
    blocks.push(`## ${label}`);
    for (const note of catNotes) {
      blocks.push(`### ${note.title}`);
      blocks.push(note.content);
    }
  }
  return "\n\n# \u9879\u76EE\u7B14\u8BB0\uFF08\u7528\u6237\u4E3A\u672C\u9879\u76EE\u8BB0\u5F55\u7684\u91CD\u8981\u4E0A\u4E0B\u6587\uFF0C\u8BF7\u59CB\u7EC8\u9075\u5B88\uFF09\n\n" + blocks.join("\n\n");
}
var import_promises, import_node_path3, import_node_crypto2, TACO_HOME, NOTES_DIR, CATEGORY_LABELS;
var init_notes = __esm({
  "src/main/notes.ts"() {
    "use strict";
    import_promises = __toESM(require("node:fs/promises"), 1);
    import_node_path3 = __toESM(require("node:path"), 1);
    import_node_crypto2 = require("node:crypto");
    TACO_HOME = import_node_path3.default.join(process.env.HOME || process.env.USERPROFILE || "~", ".taco");
    NOTES_DIR = import_node_path3.default.join(TACO_HOME, "notes");
    CATEGORY_LABELS = {
      convention: "\u4EE3\u7801\u89C4\u8303",
      credential: "\u51ED\u8BC1/\u8D26\u53F7",
      architecture: "\u67B6\u6784\u8BBE\u8BA1",
      config: "\u914D\u7F6E\u4FE1\u606F",
      other: "\u5176\u4ED6"
    };
  }
});

// node_modules/dotenv/config.js
(function() {
  require_main().config(
    Object.assign(
      {},
      require_env_options(),
      require_cli_options()(process.argv)
    )
  );
})();

// src/main/fix-path.ts
var import_node_child_process = require("node:child_process");
var import_node_path = __toESM(require("node:path"), 1);
var UNIX_FALLBACK_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin"
];
function getWindowsFallbackPaths() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appData = process.env.APPDATA || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    // Node.js / npm / nvm-windows
    import_node_path.default.join(appData, "npm"),
    import_node_path.default.join(appData, "nvm"),
    import_node_path.default.join(programFiles, "nodejs"),
    // volta
    import_node_path.default.join(localAppData, "Volta", "bin"),
    import_node_path.default.join(home, ".volta", "bin"),
    // scoop
    import_node_path.default.join(home, "scoop", "shims"),
    // pnpm
    import_node_path.default.join(localAppData, "pnpm"),
    // yarn
    import_node_path.default.join(localAppData, "Yarn", "bin"),
    // Git
    import_node_path.default.join(programFiles, "Git", "cmd"),
    import_node_path.default.join(programFilesX86, "Git", "cmd"),
    // Python
    import_node_path.default.join(localAppData, "Programs", "Python", "Python311", "Scripts"),
    import_node_path.default.join(localAppData, "Programs", "Python", "Python312", "Scripts")
  ].filter(Boolean);
}
function fixPath() {
  if (process.platform === "win32") {
    fixPathWindows();
  } else {
    fixPathUnix();
  }
}
function fixPathUnix() {
  const currentPath = process.env.PATH || "";
  try {
    const shell2 = process.env.SHELL || "/bin/zsh";
    const result = (0, import_node_child_process.execSync)(
      `${shell2} -ilc 'echo "___PATH_START___$PATH___PATH_END___"'`,
      {
        encoding: "utf-8",
        timeout: 5e3,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    const match = result.match(/___PATH_START___(.+?)___PATH_END___/);
    if (match?.[1]) {
      process.env.PATH = mergePathStr(match[1], currentPath, ":");
      return;
    }
  } catch {
    try {
      const shell2 = process.env.SHELL || "/bin/zsh";
      const result = (0, import_node_child_process.execSync)(`${shell2} -lc 'echo $PATH'`, {
        encoding: "utf-8",
        timeout: 5e3,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const shellPath = result.trim();
      if (shellPath && shellPath.includes("/")) {
        process.env.PATH = mergePathStr(shellPath, currentPath, ":");
        return;
      }
    } catch {
    }
  }
  ensurePaths(UNIX_FALLBACK_PATHS, ":");
}
function fixPathWindows() {
  const currentPath = process.env.PATH || process.env.Path || "";
  try {
    const systemPath = readRegistryPath(
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
      "Path"
    );
    const userPath = readRegistryPath("HKCU\\Environment", "Path");
    if (systemPath || userPath) {
      const registryPath = [systemPath, userPath].filter(Boolean).join(";");
      const merged = mergePathStr(registryPath, currentPath, ";");
      process.env.PATH = merged;
      process.env.Path = merged;
      return;
    }
  } catch {
  }
  try {
    const result = (0, import_node_child_process.execSync)(
      `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')"`,
      {
        encoding: "utf-8",
        timeout: 5e3,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    const psPath = result.trim();
    if (psPath && psPath.length > 10) {
      const merged = mergePathStr(psPath, currentPath, ";");
      process.env.PATH = merged;
      process.env.Path = merged;
      return;
    }
  } catch {
  }
  ensurePaths(getWindowsFallbackPaths(), ";");
}
function readRegistryPath(key, valueName) {
  try {
    const result = (0, import_node_child_process.execSync)(`reg query "${key}" /v ${valueName}`, {
      encoding: "utf-8",
      timeout: 3e3,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const match = result.match(/REG_(?:EXPAND_)?SZ\s+(.+)/i);
    return match?.[1]?.trim() || "";
  } catch {
    return "";
  }
}
function mergePathStr(primary, secondary, sep) {
  const seen = /* @__PURE__ */ new Set();
  const parts = [];
  const normalize = sep === ";" ? (p) => p.toLowerCase().replace(/[/\\]+$/, "") : (p) => p;
  for (const raw of primary.split(sep)) {
    const p = raw.trim();
    const key = normalize(p);
    if (p && !seen.has(key)) {
      seen.add(key);
      parts.push(p);
    }
  }
  for (const raw of secondary.split(sep)) {
    const p = raw.trim();
    const key = normalize(p);
    if (p && !seen.has(key)) {
      seen.add(key);
      parts.push(p);
    }
  }
  return parts.join(sep);
}
function ensurePaths(fallbacks, sep) {
  const currentPath = process.env.PATH || process.env.Path || "";
  const pathSet = new Set(
    currentPath.split(sep).map(
      (p) => sep === ";" ? p.toLowerCase().replace(/[/\\]+$/, "") : p
    )
  );
  const missing = fallbacks.filter((p) => {
    const key = sep === ";" ? p.toLowerCase().replace(/[/\\]+$/, "") : p;
    return !pathSet.has(key);
  });
  if (missing.length > 0) {
    const merged = [...missing, currentPath].join(sep);
    process.env.PATH = merged;
    if (sep === ";") process.env.Path = merged;
  }
}

// src/main/main.ts
var import_electron6 = require("electron");
var import_node_path5 = __toESM(require("node:path"), 1);

// src/main/ipc.ts
var import_electron5 = require("electron");
var import_node_child_process5 = require("node:child_process");
var fs6 = __toESM(require("node:fs/promises"), 1);
var import_node_fs3 = require("node:fs");
var nodePath2 = __toESM(require("node:path"), 1);

// src/shared/ipc.ts
var IpcChannel = {
  /** renderer → main (invoke/handle, 非流式请求) */
  CHAT_SEND: "chat:send",
  /** renderer → main (send/on, 发起流式请求) */
  CHAT_STREAM: "chat:stream",
  /** renderer → main (send/on, 终止当前 chat 流式请求) */
  CHAT_ABORT: "chat:abort",
  /** main → renderer (send/on, 流式数据推送) */
  CHAT_CHUNK: "chat:chunk",
  /** renderer → main (send/on, 发起 agent 流式请求) */
  AGENT_STREAM: "agent:stream",
  /** main → renderer (send/on, agent 事件推送) */
  AGENT_EVENT: "agent:event",
  /** renderer → main (send/on, 用户对风险操作的确认响应) */
  AGENT_CONFIRM: "agent:confirm",
  /** renderer → main (send/on, 终止当前 agent 执行) */
  AGENT_ABORT: "agent:abort",
  /** renderer → main (invoke/handle, 选择目录对话框) */
  SELECT_DIRECTORY: "dialog:select-directory",
  /** renderer → main (invoke/handle, 用编辑器打开文件) */
  OPEN_IN_EDITOR: "shell:open-in-editor",
  /** renderer → main (invoke/handle, 文件撤销/恢复) */
  FILE_REVERT: "file:revert",
  /** renderer → main (invoke/handle, 删除新建的文件) */
  FILE_DELETE: "file:delete",
  /** renderer → main (invoke/handle, 读取文件内容) */
  FILE_READ: "file:read",
  /** renderer → main (invoke/handle, 写入文件内容) */
  FILE_WRITE: "file:write",
  /** 终端 — renderer ↔ main 双向通信 */
  TERMINAL_SPAWN: "terminal:spawn",
  TERMINAL_INPUT: "terminal:input",
  TERMINAL_OUTPUT: "terminal:output",
  TERMINAL_RESIZE: "terminal:resize",
  TERMINAL_KILL: "terminal:kill",
  TERMINAL_EXIT: "terminal:exit",
  /** 工作区目录树 */
  WORKSPACE_TREE: "workspace:tree",
  /** renderer → main, 开始监听工作区文件变化 */
  WORKSPACE_WATCH: "workspace:watch",
  /** renderer → main, 停止监听工作区文件变化 */
  WORKSPACE_UNWATCH: "workspace:unwatch",
  /** main → renderer, 工作区文件发生变化 */
  WORKSPACE_CHANGED: "workspace:changed",
  /** Git 版本控制 */
  GIT_LOG: "git:log",
  GIT_COMMIT: "git:commit",
  GIT_ROLLBACK: "git:rollback",
  GIT_COMMIT_FILES: "git:commit-files",
  /** Skills 管理 */
  SKILLS_LIST: "skills:list",
  SKILLS_INSTALL: "skills:install",
  SKILLS_UNINSTALL: "skills:uninstall",
  SKILLS_TOGGLE: "skills:toggle",
  /** Agent 自动授权分类设置 */
  AGENT_AUTO_APPROVE: "agent:auto-approve",
  /** 项目笔记/记忆 */
  NOTES_LIST: "notes:list",
  NOTES_SAVE: "notes:save",
  NOTES_DELETE: "notes:delete",
  /** MCP 管理 */
  MCP_LIST: "mcp:list",
  MCP_SAVE: "mcp:save",
  MCP_REMOVE: "mcp:remove",
  MCP_TOGGLE: "mcp:toggle",
  /** main → renderer, 在内嵌浏览器中打开 URL */
  OPEN_URL: "app:open-url",
  /** 浏览器自动化（已废弃：统一使用外部 BrowserWindow + CDP） */
  BROWSER_ACTION: "browser:action",
  /** renderer → main, 设置浏览器全局接管模式 */
  BROWSER_AUTO_TAKEOVER: "browser:auto-takeover",
  /** renderer → main, 设置浏览器调试模式（是否打开 DevTools） */
  BROWSER_DEBUG_MODE: "browser:debug-mode",
  /** renderer → main, 设置浏览器隐藏窗口模式（打开时是否隐藏窗口） */
  BROWSER_HIDDEN_MODE: "browser:hidden-mode",
  /** 外部浏览器窗口 (BrowserWindow 模式) */
  EXTERNAL_BROWSER_OPEN: "browser:ext-open",
  EXTERNAL_BROWSER_CLOSE: "browser:ext-close",
  EXTERNAL_BROWSER_NAVIGATE: "browser:ext-navigate",
  EXTERNAL_BROWSER_FOCUS: "browser:ext-focus",
  /** main → renderer, 外部浏览器窗口状态变更 */
  EXTERNAL_BROWSER_STATUS: "browser:ext-status",
  /** renderer → main, 同步浏览器模式设置 */
  BROWSER_MODE: "browser:mode",
  /** renderer → main, 打开日志目录 */
  OPEN_LOG_DIR: "app:open-log-dir",
  /** 窗口拖拽 — 手动实现以获取自定义光标控制 */
  WINDOW_DRAG_START: "window:drag-start",
  WINDOW_DRAGGING: "window:dragging",
  WINDOW_DRAG_END: "window:drag-end",
  /** renderer → main, 双击顶栏切换最大化 */
  WINDOW_TOGGLE_MAXIMIZE: "window:toggle-maximize"
};
var editorCommands = {
  cursor: { label: "Cursor", macApp: "Cursor", cli: "cursor" },
  vscode: { label: "VS Code", macApp: "Visual Studio Code", cli: "code" },
  webstorm: { label: "WebStorm", macApp: "WebStorm", cli: "webstorm" },
  sublime: { label: "Sublime Text", macApp: "Sublime Text", cli: "subl" },
  system: { label: "\u7CFB\u7EDF\u9ED8\u8BA4", macApp: "", cli: "xdg-open" }
};

// src/main/tools.ts
var import_promises2 = __toESM(require("node:fs/promises"), 1);
var import_node_path4 = __toESM(require("node:path"), 1);
var import_node_child_process3 = require("node:child_process");

// src/main/logger.ts
var import_electron = require("electron");
var import_node_path2 = __toESM(require("node:path"), 1);
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_crypto = require("node:crypto");
var logDirs = /* @__PURE__ */ new Map();
function normalizeScope(scope) {
  if (!scope) return "global";
  const s = scope.trim();
  if (!s) return "global";
  return (0, import_node_crypto.createHash)("sha256").update(s).digest("hex").slice(0, 16);
}
function ensureLogDir(scope) {
  const key = normalizeScope(scope);
  const cached = logDirs.get(key);
  if (cached) return cached;
  const dir = import_node_path2.default.join(import_electron.app.getPath("userData"), "logs", key);
  import_node_fs.default.mkdirSync(dir, { recursive: true });
  logDirs.set(key, dir);
  return dir;
}
function getLogFile(scope) {
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  return import_node_path2.default.join(ensureLogDir(scope), `taco-${date}.log`);
}
function appendLog(content, scope) {
  try {
    import_node_fs.default.appendFileSync(getLogFile(scope), content + "\n", "utf-8");
  } catch {
  }
}
function log(tag, data, scope) {
  const time = (/* @__PURE__ */ new Date()).toISOString();
  const json = JSON.stringify(data, null, 2);
  appendLog(`[${time}] [${tag}]
${json}
`, scope);
}
function logInfo(tag, message, data, scope) {
  const time = (/* @__PURE__ */ new Date()).toISOString();
  const extra = data !== void 0 ? `
${JSON.stringify(data, null, 2)}` : "";
  appendLog(`[${time}] [INFO] [${tag}] ${message}${extra}
`, scope);
}
function getLogDir(scope) {
  return ensureLogDir(scope);
}

// src/main/browser.ts
var import_electron2 = require("electron");
var import_node_fs2 = require("node:fs");
var nodePath = __toESM(require("node:path"), 1);
var browserDebugMode = false;
var browserHiddenMode = true;
function setBrowserDebugMode(enabled) {
  browserDebugMode = enabled;
  for (const inst of browserInstances.values()) {
    if (!inst.win.isDestroyed()) {
      if (enabled) {
        inst.win.webContents.openDevTools({ mode: "bottom" });
      } else {
        inst.win.webContents.closeDevTools();
      }
    }
  }
}
function setBrowserHiddenMode(enabled) {
  browserHiddenMode = enabled;
  for (const inst of browserInstances.values()) {
    if (inst.win.isDestroyed()) continue;
    if (enabled) {
      if (inst.win.isVisible()) inst.win.hide();
    } else {
      if (!inst.win.isVisible()) inst.win.showInactive();
    }
  }
}
import_electron2.ipcMain.on(IpcChannel.BROWSER_DEBUG_MODE, (_e, enabled) => {
  setBrowserDebugMode(enabled);
});
import_electron2.ipcMain.on(IpcChannel.BROWSER_HIDDEN_MODE, (_e, enabled) => {
  setBrowserHiddenMode(enabled);
});
async function executeBrowserAction(payload, appId) {
  return executeExternalBrowserAction(payload, appId || DEFAULT_APP_ID);
}
async function ensureCdpAttached(wc, appId = DEFAULT_APP_ID) {
  if (!wc.debugger.isAttached()) {
    try {
      wc.debugger.attach("1.3");
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("Already attached"))) {
        throw err;
      }
    }
    try {
      const inst = getBrowserInstance(appId);
      const seed = inst?.seed || generateFingerprintSeed();
      const ua = inst?.ua || generateChromeUA();
      const script = buildStealthJS(seed, ua);
      await wc.debugger.sendCommand("Page.enable");
      await wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: script
      }).catch(() => {
      });
      await wc.debugger.sendCommand("Emulation.setUserAgentOverride", {
        userAgent: ua,
        platform: process.platform === "darwin" ? "MacIntel" : process.platform === "win32" ? "Win32" : "Linux x86_64"
      }).catch(() => {
      });
    } catch {
    }
  }
}
async function getElementCenter(wc, selector) {
  const rect = await wc.executeJavaScript(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()
  `);
  if (!rect) throw new Error(`\u5143\u7D20\u4E0D\u5B58\u5728: ${selector}`);
  return rect;
}
async function executeExternalBrowserAction(payload, appId = DEFAULT_APP_ID) {
  const { action, params } = payload;
  if (action === "navigate") {
    const url = String(params.url ?? "");
    const finalUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const extWinExisting = getExternalBrowserWin(appId);
    if (extWinExisting) {
      const currentUrl = extWinExisting.webContents.getURL();
      if (isSameOriginUrl(currentUrl, finalUrl)) {
        focusExternalBrowser(appId);
        return { success: true, data: `\u6D4F\u89C8\u5668[${appId}]\u5DF2\u5728 ${currentUrl}\uFF0C\u5DF2\u805A\u7126\u7A97\u53E3\uFF08\u672A\u91CD\u65B0\u52A0\u8F7D\uFF09` };
      }
    }
    openExternalBrowser(finalUrl, appId);
    const extWin2 = getExternalBrowserWin(appId);
    if (extWin2) {
      await new Promise((resolve2) => {
        const timer = setTimeout(resolve2, 1e4);
        extWin2.webContents.once("did-finish-load", () => {
          clearTimeout(timer);
          resolve2();
        });
      });
    }
    return { success: true, data: `\u5DF2\u5728\u6D4F\u89C8\u5668[${appId}]\u4E2D\u6253\u5F00 ${finalUrl}` };
  }
  const extWin = getExternalBrowserWin(appId);
  if (!extWin) return { success: false, error: `\u6D4F\u89C8\u5668[${appId}]\u672A\u6253\u5F00\uFF0C\u8BF7\u5148\u4F7F\u7528 browser_navigate \u6253\u5F00\u76EE\u6807\u9875\u9762` };
  const wc = extWin.webContents;
  try {
    switch (action) {
      // ── 页面信息 ──
      case "get_info": {
        const url = wc.getURL();
        const title = wc.getTitle();
        const viewport = await wc.executeJavaScript(
          `JSON.stringify({ width: window.innerWidth, height: window.innerHeight })`
        );
        return { success: true, data: JSON.stringify({ url, title, viewport: JSON.parse(viewport) }) };
      }
      // ── 截图：按浏览器窗口整屏截图 ──
      case "screenshot": {
        await ensureCdpAttached(wc, appId);
        const { data: base64 } = await wc.debugger.sendCommand("Page.captureScreenshot", {
          format: "png",
          fromSurface: true
        });
        const dataUrl = `data:image/png;base64,${base64}`;
        let pageInfo = {
          title: wc.getTitle(),
          url: wc.getURL(),
          viewport: { w: 0, h: 0 },
          elements: []
        };
        try {
          const raw = await wc.executeJavaScript(`
            (function() {
              var info = { title: document.title, url: location.href, viewport: { w: window.innerWidth, h: window.innerHeight } };
              var els = [];
              document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick], h1, h2, h3, h4, img[alt], label').forEach(function(el, i) {
                if (i > 80) return;
                var rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return;
                var tag = el.tagName.toLowerCase();
                var text = (el.textContent || '').trim().slice(0, 80);
                var obj = { tag: tag, text: text };
                if (el.id) obj.id = el.id;
                if (el.className && typeof el.className === 'string') obj.class = el.className.split(' ').slice(0, 3).join(' ');
                if (el.type) obj.type = el.type;
                if (el.name) obj.name = el.name;
                if (el.placeholder) obj.placeholder = el.placeholder;
                if (el.href) obj.href = el.href;
                if (el.alt) obj.alt = el.alt;
                if (el.value) obj.value = String(el.value).slice(0, 40);
                obj.pos = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
                els.push(obj);
              });
              info.elements = els;
              return JSON.stringify(info);
            })()
          `);
          pageInfo = JSON.parse(String(raw));
        } catch {
        }
        return {
          success: true,
          data: JSON.stringify({
            screenshot: dataUrl,
            page: pageInfo
          })
        };
      }
      // ── 点击：CDP Input.dispatchMouseEvent —— 支持选择器或坐标、左/右/中键、双击 ──
      case "click": {
        const selector = params.selector ? String(params.selector) : "";
        const btn = String(params.button ?? "left");
        const clicks = Number(params.clickCount ?? 1);
        let cx, cy;
        if (selector) {
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `);
          await new Promise((r) => setTimeout(r, 100));
          const pos = await getElementCenter(wc, selector);
          cx = pos.x;
          cy = pos.y;
        } else if (params.x != null && params.y != null) {
          cx = Number(params.x);
          cy = Number(params.y);
        } else {
          return { success: false, error: "\u9700\u8981\u63D0\u4F9B selector \u6216 x/y \u5750\u6807" };
        }
        await ensureCdpAttached(wc, appId);
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: cx,
          y: cy
        });
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: cx,
          y: cy,
          button: btn,
          clickCount: clicks
        });
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: cx,
          y: cy,
          button: btn,
          clickCount: clicks
        });
        const label = selector || `(${Math.round(cx)},${Math.round(cy)})`;
        return { success: true, data: `\u5DF2${btn === "right" ? "\u53F3\u952E" : ""}${clicks > 1 ? "\u53CC" : ""}\u70B9\u51FB ${label}` };
      }
      // ── 输入：CDP 鼠标点击聚焦 + 逐字符键盘模拟输入（模拟真人打字节奏） ──
      case "type": {
        const selector = String(params.selector ?? "");
        const text = String(params.text ?? "");
        const submit = Boolean(params.submit);
        const clearFirst = params.clear !== false;
        if (selector) {
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `);
          await new Promise((r) => setTimeout(r, 150));
        }
        const { x, y } = await getElementCenter(wc, selector);
        await ensureCdpAttached(wc, appId);
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y
        });
        await new Promise((r) => setTimeout(r, 30 + Math.random() * 50));
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1
        });
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1
        });
        await new Promise((r) => setTimeout(r, 80 + Math.random() * 60));
        if (clearFirst) {
          const selectAllMod = process.platform === "darwin" ? 4 : 2;
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "a",
            code: "KeyA",
            windowsVirtualKeyCode: 65,
            modifiers: selectAllMod
          });
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "a",
            code: "KeyA",
            windowsVirtualKeyCode: 65,
            modifiers: selectAllMod
          });
          await new Promise((r) => setTimeout(r, 30));
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8
          });
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8
          });
          await new Promise((r) => setTimeout(r, 60 + Math.random() * 40));
        }
        for (const char of text) {
          const code = char.charCodeAt(0);
          if (code >= 32 && code < 127) {
            const isUpper = char >= "A" && char <= "Z";
            const isLetter = /^[a-zA-Z]$/.test(char);
            const vk = isLetter ? char.toUpperCase().charCodeAt(0) : code;
            const keyCode = isLetter ? `Key${char.toUpperCase()}` : void 0;
            await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
              type: "keyDown",
              key: char,
              ...keyCode ? { code: keyCode } : {},
              windowsVirtualKeyCode: vk,
              ...isUpper ? {
                modifiers: 8
                /* Shift */
              } : {}
            });
            await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
              type: "char",
              text: char,
              unmodifiedText: char,
              key: char,
              windowsVirtualKeyCode: code
            });
            await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: char,
              ...keyCode ? { code: keyCode } : {},
              windowsVirtualKeyCode: vk,
              ...isUpper ? { modifiers: 8 } : {}
            });
          } else {
            await wc.debugger.sendCommand("Input.insertText", { text: char });
          }
          await new Promise((r) => setTimeout(r, 30 + Math.random() * 90));
        }
        if (submit) {
          await new Promise((r) => setTimeout(r, 100 + Math.random() * 80));
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13
          });
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "char",
            text: "\r",
            key: "Enter",
            windowsVirtualKeyCode: 13
          });
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13
          });
        }
        return { success: true, data: `\u5DF2\u8F93\u5165 "${text}" \u5230 ${selector}${submit ? " \u5E76\u63D0\u4EA4" : ""}` };
      }
      // ── 滚动：CDP 鼠标滚轮事件，支持选择器定位、多步平滑滚动 ──
      case "scroll": {
        const direction = String(params.direction ?? "down");
        const amount = Number(params.amount ?? 300);
        let deltaX = Number(params.x ?? 0);
        let deltaY = Number(params.y ?? 0);
        if (params.direction) {
          deltaX = 0;
          deltaY = 0;
          switch (direction) {
            case "down":
              deltaY = amount;
              break;
            case "up":
              deltaY = -amount;
              break;
            case "right":
              deltaX = amount;
              break;
            case "left":
              deltaX = -amount;
              break;
          }
        }
        const selector = params.selector ? String(params.selector) : "";
        await ensureCdpAttached(wc, appId);
        let scrollX, scrollY;
        if (selector) {
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `);
          await new Promise((r) => setTimeout(r, 100));
          const pos = await getElementCenter(wc, selector);
          scrollX = pos.x;
          scrollY = pos.y;
        } else {
          const vpStr = await wc.executeJavaScript(
            `JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`
          );
          const vp = JSON.parse(vpStr);
          scrollX = Math.round(vp.w / 2);
          scrollY = Math.round(vp.h / 2);
        }
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: scrollX,
          y: scrollY
        });
        await new Promise((r) => setTimeout(r, 30));
        const scrollSteps = 5;
        const stepDeltaX = Math.round(deltaX / scrollSteps);
        const stepDeltaY = Math.round(deltaY / scrollSteps);
        for (let i = 0; i < scrollSteps; i++) {
          const dx = i === scrollSteps - 1 ? deltaX - stepDeltaX * (scrollSteps - 1) : stepDeltaX;
          const dy = i === scrollSteps - 1 ? deltaY - stepDeltaY * (scrollSteps - 1) : stepDeltaY;
          if (dx === 0 && dy === 0) continue;
          await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: scrollX,
            y: scrollY,
            deltaX: dx,
            deltaY: dy
          });
          await new Promise((r) => setTimeout(r, 30 + Math.random() * 20));
        }
        const target = selector || "\u9875\u9762\u4E2D\u5FC3";
        return { success: true, data: `\u5DF2\u5728 ${target} \u6EDA\u52A8 (${deltaX}, ${deltaY})` };
      }
      // ── 获取内容 ──
      case "get_content": {
        const selector = String(params.selector ?? "body");
        const result = await wc.executeJavaScript(`
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return 'null';
            return el.innerText?.slice(0, 30000) || '';
          })()
        `);
        return { success: true, data: result };
      }
      // ── 等待 ──
      case "wait": {
        const ms = Number(params.ms ?? 1e3);
        await new Promise((r) => setTimeout(r, ms));
        return { success: true, data: `\u7B49\u5F85\u4E86 ${ms}ms` };
      }
      // ── 执行 JS ──
      case "evaluate": {
        const code = String(params.code ?? "");
        const result = await wc.executeJavaScript(code);
        return { success: true, data: typeof result === "string" ? result : JSON.stringify(result) };
      }
      // ── 鼠标悬停：CDP mouseMoved ──
      case "hover": {
        const selector = params.selector ? String(params.selector) : "";
        let hx, hy;
        if (selector) {
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `);
          await new Promise((r) => setTimeout(r, 100));
          const pos = await getElementCenter(wc, selector);
          hx = pos.x;
          hy = pos.y;
        } else if (params.x != null && params.y != null) {
          hx = Number(params.x);
          hy = Number(params.y);
        } else {
          return { success: false, error: "\u9700\u8981\u63D0\u4F9B selector \u6216 x/y \u5750\u6807" };
        }
        await ensureCdpAttached(wc, appId);
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: hx,
          y: hy
        });
        return { success: true, data: `\u5DF2\u60AC\u505C\u5728 ${selector || `(${Math.round(hx)},${Math.round(hy)})`}` };
      }
      // ── 键盘按键：CDP Input.dispatchKeyEvent ──
      case "keypress": {
        const key = String(params.key ?? "");
        if (!key) return { success: false, error: "key \u53C2\u6570\u7F3A\u5931" };
        const mods = Array.isArray(params.modifiers) ? params.modifiers : [];
        let modifierFlags = 0;
        if (mods.includes("alt")) modifierFlags |= 1;
        if (mods.includes("ctrl")) modifierFlags |= 2;
        if (mods.includes("meta")) modifierFlags |= 4;
        if (mods.includes("shift")) modifierFlags |= 8;
        const keyMap = {
          "Enter": { code: "Enter", vk: 13 },
          "Tab": { code: "Tab", vk: 9 },
          "Escape": { code: "Escape", vk: 27 },
          "Backspace": { code: "Backspace", vk: 8 },
          "Delete": { code: "Delete", vk: 46 },
          "Space": { code: "Space", vk: 32 },
          " ": { code: "Space", vk: 32 },
          "ArrowUp": { code: "ArrowUp", vk: 38 },
          "ArrowDown": { code: "ArrowDown", vk: 40 },
          "ArrowLeft": { code: "ArrowLeft", vk: 37 },
          "ArrowRight": { code: "ArrowRight", vk: 39 },
          "Home": { code: "Home", vk: 36 },
          "End": { code: "End", vk: 35 },
          "PageUp": { code: "PageUp", vk: 33 },
          "PageDown": { code: "PageDown", vk: 34 },
          "F1": { code: "F1", vk: 112 },
          "F2": { code: "F2", vk: 113 },
          "F3": { code: "F3", vk: 114 },
          "F4": { code: "F4", vk: 115 },
          "F5": { code: "F5", vk: 116 },
          "F6": { code: "F6", vk: 117 },
          "F7": { code: "F7", vk: 118 },
          "F8": { code: "F8", vk: 119 },
          "F9": { code: "F9", vk: 120 },
          "F10": { code: "F10", vk: 121 },
          "F11": { code: "F11", vk: 122 },
          "F12": { code: "F12", vk: 123 }
        };
        await ensureCdpAttached(wc, appId);
        const mapped = keyMap[key];
        if (mapped) {
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            code: mapped.code,
            windowsVirtualKeyCode: mapped.vk,
            modifiers: modifierFlags
          });
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
            code: mapped.code,
            windowsVirtualKeyCode: mapped.vk,
            modifiers: modifierFlags
          });
        } else if (key.length === 1) {
          const charCode = key.charCodeAt(0);
          const vk = key.toUpperCase().charCodeAt(0);
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key,
            code: `Key${key.toUpperCase()}`,
            windowsVirtualKeyCode: vk,
            modifiers: modifierFlags
          });
          if (!modifierFlags) {
            await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
              type: "char",
              text: key,
              unmodifiedText: key,
              key,
              windowsVirtualKeyCode: charCode
            });
          }
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key,
            code: `Key${key.toUpperCase()}`,
            windowsVirtualKeyCode: vk,
            modifiers: modifierFlags
          });
        } else {
          return { success: false, error: `\u4E0D\u652F\u6301\u7684\u6309\u952E: ${key}` };
        }
        const modStr = mods.length > 0 ? mods.join("+") + "+" : "";
        return { success: true, data: `\u5DF2\u6309\u4E0B ${modStr}${key}` };
      }
      // ── 拖拽：CDP mouseMoved + mousePressed + 多步 mouseMoved + mouseReleased ──
      case "drag": {
        let fx, fy, tx, ty;
        const dragSteps = Number(params.steps ?? 10);
        if (params.fromSelector) {
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(String(params.fromSelector))})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `);
          await new Promise((r) => setTimeout(r, 100));
          const from = await getElementCenter(wc, String(params.fromSelector));
          fx = from.x;
          fy = from.y;
        } else if (params.fromX != null && params.fromY != null) {
          fx = Number(params.fromX);
          fy = Number(params.fromY);
        } else {
          return { success: false, error: "\u9700\u8981\u63D0\u4F9B fromSelector \u6216 fromX/fromY" };
        }
        if (params.toSelector) {
          const to = await getElementCenter(wc, String(params.toSelector));
          tx = to.x;
          ty = to.y;
        } else if (params.toX != null && params.toY != null) {
          tx = Number(params.toX);
          ty = Number(params.toY);
        } else {
          return { success: false, error: "\u9700\u8981\u63D0\u4F9B toSelector \u6216 toX/toY" };
        }
        await ensureCdpAttached(wc, appId);
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: fx,
          y: fy
        });
        await new Promise((r) => setTimeout(r, 50));
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: fx,
          y: fy,
          button: "left",
          clickCount: 1
        });
        for (let i = 1; i <= dragSteps; i++) {
          const progress = i / dragSteps;
          const mx = fx + (tx - fx) * progress;
          const my = fy + (ty - fy) * progress;
          await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: mx,
            y: my
          });
          await new Promise((r) => setTimeout(r, 16));
        }
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: tx,
          y: ty,
          button: "left",
          clickCount: 1
        });
        return { success: true, data: `\u5DF2\u62D6\u62FD\u4ECE (${Math.round(fx)},${Math.round(fy)}) \u5230 (${Math.round(tx)},${Math.round(ty)})` };
      }
      // ── 选择下拉框选项：CDP 鼠标模拟点击 + 键盘导航 ──
      case "select": {
        const selector = String(params.selector ?? "");
        const value = params.value != null ? String(params.value) : void 0;
        const label = params.label != null ? String(params.label) : void 0;
        if (!selector) return { success: false, error: "selector \u53C2\u6570\u7F3A\u5931" };
        await wc.executeJavaScript(`
          document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
        `);
        await new Promise((r) => setTimeout(r, 150));
        const { x: sx, y: sy } = await getElementCenter(wc, selector);
        await ensureCdpAttached(wc, appId);
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: sx,
          y: sy
        });
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 30));
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: sx,
          y: sy,
          button: "left",
          clickCount: 1
        });
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: sx,
          y: sy,
          button: "left",
          clickCount: 1
        });
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 100));
        const optionInfo = await wc.executeJavaScript(`
          (function() {
            const sel = document.querySelector(${JSON.stringify(selector)});
            if (!sel || sel.tagName !== 'SELECT') return null;
            const opts = Array.from(sel.options);
            const currentIdx = sel.selectedIndex;
            let targetIdx = -1;
            if (${JSON.stringify(value)} != null) {
              targetIdx = opts.findIndex(o => o.value === ${JSON.stringify(value)});
            }
            if (targetIdx < 0 && ${JSON.stringify(label)} != null) {
              targetIdx = opts.findIndex(o => o.textContent?.trim() === ${JSON.stringify(label)});
            }
            if (targetIdx < 0) return null;
            return { currentIdx, targetIdx, label: opts[targetIdx].textContent?.trim() || opts[targetIdx].value };
          })()
        `);
        if (!optionInfo) {
          return { success: false, error: `\u672A\u627E\u5230\u5339\u914D\u7684\u9009\u9879 (value=${value}, label=${label})` };
        }
        const diff = optionInfo.targetIdx - optionInfo.currentIdx;
        const arrowKey = diff > 0 ? "ArrowDown" : "ArrowUp";
        const arrowVk = diff > 0 ? 40 : 38;
        const steps = Math.abs(diff);
        for (let i = 0; i < steps; i++) {
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: arrowKey,
            code: arrowKey,
            windowsVirtualKeyCode: arrowVk
          });
          await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: arrowKey,
            code: arrowKey,
            windowsVirtualKeyCode: arrowVk
          });
          await new Promise((r) => setTimeout(r, 50 + Math.random() * 40));
        }
        await new Promise((r) => setTimeout(r, 60 + Math.random() * 40));
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13
        });
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13
        });
        return { success: true, data: `\u5DF2\u9009\u62E9 "${optionInfo.label}"` };
      }
      default:
        return { success: false, error: `\u5916\u90E8\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u64CD\u4F5C: ${action}` };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
var BROWSER_PROFILES_DIR = nodePath.join(import_electron2.app.getPath("home"), ".taco", "browser-profiles");
var browserInstances = /* @__PURE__ */ new Map();
var DEFAULT_APP_ID = "default";
function ensureProfilesDir() {
  if (!(0, import_node_fs2.existsSync)(BROWSER_PROFILES_DIR)) {
    (0, import_node_fs2.mkdirSync)(BROWSER_PROFILES_DIR, { recursive: true });
  }
}
function loadOrCreateProfile(appId) {
  ensureProfilesDir();
  const profilePath = nodePath.join(BROWSER_PROFILES_DIR, `${appId}.json`);
  if ((0, import_node_fs2.existsSync)(profilePath)) {
    try {
      const data = JSON.parse((0, import_node_fs2.readFileSync)(profilePath, "utf-8"));
      data.lastUsedAt = (/* @__PURE__ */ new Date()).toISOString();
      (0, import_node_fs2.writeFileSync)(profilePath, JSON.stringify(data, null, 2), "utf-8");
      return data;
    } catch {
    }
  }
  const profile = {
    appId,
    seed: generateFingerprintSeed(),
    ua: generateChromeUA(),
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    lastUsedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  (0, import_node_fs2.writeFileSync)(profilePath, JSON.stringify(profile, null, 2), "utf-8");
  return profile;
}
function sendExternalStatus(status) {
  const mainWin = import_electron2.BrowserWindow.getAllWindows().find((w) => !browserInstances.has(getAppIdByWin(w)));
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(IpcChannel.EXTERNAL_BROWSER_STATUS, status);
  }
}
function getAppIdByWin(win) {
  for (const [id, inst] of browserInstances) {
    if (inst.win === win) return id;
  }
  return "";
}
function isSameOriginUrl(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const normalize = (u) => `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    return normalize(ua) === normalize(ub);
  } catch {
    return a === b;
  }
}
function generateChromeUA() {
  const major = 120 + Math.floor(Math.random() * 13);
  const build = 6e3 + Math.floor(Math.random() * 400);
  const patch = Math.floor(Math.random() * 200);
  const chromeVer = `${major}.0.${build}.${patch}`;
  const platform = process.platform === "darwin" ? `Macintosh; Intel Mac OS X 10_15_${7 + Math.floor(Math.random() * 3)}` : process.platform === "win32" ? `Windows NT 10.0; Win64; x64` : `X11; Linux x86_64`;
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
}
function generateFingerprintSeed() {
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s;
}
function buildStealthJS(seed, ua) {
  return `
(function(){
  if (window.__stealth_applied__) return;
  window.__stealth_applied__ = true;

  // \u2500\u2500 \u57FA\u4E8E seed \u7684\u786E\u5B9A\u6027\u4F2A\u968F\u673A\u6570\u751F\u6210\u5668\uFF08\u540C seed \u6C38\u8FDC\u76F8\u540C\u5E8F\u5217\uFF09\u2500\u2500
  var SEED = ${JSON.stringify(seed)};
  var _idx = 0;
  function seedRand() {
    var h = 0;
    var s = SEED + ':' + (_idx++);
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return (((h >>> 0) % 10000) / 10000);
  }

  // \u2500\u2500 1. navigator.webdriver \u2500\u2500
  Object.defineProperty(navigator, 'webdriver', {
    get: function() { return undefined; },
    configurable: true,
  });

  // \u2500\u2500 2. User-Agent \u4E00\u81F4\u6027 \u2500\u2500
  var FAKE_UA = ${JSON.stringify(ua)};
  try {
    Object.defineProperty(navigator, 'userAgent', {
      get: function() { return FAKE_UA; }, configurable: true,
    });
    Object.defineProperty(navigator, 'appVersion', {
      get: function() { return FAKE_UA.slice(FAKE_UA.indexOf('/') + 1); }, configurable: true,
    });
  } catch(e){}

  // \u2500\u2500 3. window.chrome \u2500\u2500
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      onMessage: { addListener: function(){}, removeListener: function(){} },
      sendMessage: function(){},
      connect: function(){ return { onMessage: { addListener: function(){} }, postMessage: function(){} }; },
    };
  }
  if (!window.chrome.loadTimes) window.chrome.loadTimes = function(){ return {}; };
  if (!window.chrome.csi) window.chrome.csi = function(){ return {}; };

  // \u2500\u2500 4. navigator.plugins \u2500\u2500
  Object.defineProperty(navigator, 'plugins', {
    get: function() {
      var a = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
      ];
      a.refresh = function(){};
      a.item = function(i){ return a[i] || null; };
      a.namedItem = function(n){ return a.find(function(p){ return p.name === n; }) || null; };
      return a;
    }, configurable: true,
  });

  // \u2500\u2500 5. navigator.mimeTypes \u2500\u2500
  Object.defineProperty(navigator, 'mimeTypes', {
    get: function() {
      return [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ];
    }, configurable: true,
  });

  // \u2500\u2500 6. navigator.languages \u2500\u2500
  Object.defineProperty(navigator, 'languages', {
    get: function() { return ['zh-CN', 'zh', 'en-US', 'en']; },
    configurable: true,
  });

  // \u2500\u2500 7. navigator.hardwareConcurrency\uFF08seed \u51B3\u5B9A\uFF0C4-16\uFF09\u2500\u2500
  var _cores = 4 + Math.floor(seedRand() * 13);
  _cores = _cores % 2 === 0 ? _cores : _cores + 1; // \u4FDD\u6301\u5076\u6570
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: function() { return _cores; }, configurable: true,
  });

  // \u2500\u2500 8. navigator.deviceMemory\uFF08seed \u51B3\u5B9A\uFF0C4/8/16\uFF09\u2500\u2500
  var _memArr = [4, 8, 8, 16];
  var _mem = _memArr[Math.floor(seedRand() * _memArr.length)];
  try {
    Object.defineProperty(navigator, 'deviceMemory', {
      get: function() { return _mem; }, configurable: true,
    });
  } catch(e){}

  // \u2500\u2500 9. navigator.platform \u2500\u2500
  try {
    var _plat = ${JSON.stringify(
    process.platform === "darwin" ? "MacIntel" : process.platform === "win32" ? "Win32" : "Linux x86_64"
  )};
    Object.defineProperty(navigator, 'platform', {
      get: function() { return _plat; }, configurable: true,
    });
  } catch(e){}

  // \u2500\u2500 10. screen \u5206\u8FA8\u7387\uFF08\u56FA\u5B9A 1920x1080\uFF09\u2500\u2500
  var _scr = [1920, 1080];
  try {
    Object.defineProperty(screen, 'width', { get: function(){ return _scr[0]; } });
    Object.defineProperty(screen, 'height', { get: function(){ return _scr[1]; } });
    Object.defineProperty(screen, 'availWidth', { get: function(){ return _scr[0]; } });
    Object.defineProperty(screen, 'availHeight', { get: function(){ return _scr[1] - 40; } });
    Object.defineProperty(screen, 'colorDepth', { get: function(){ return 24; } });
    Object.defineProperty(screen, 'pixelDepth', { get: function(){ return 24; } });
  } catch(e){}

  // \u2500\u2500 11. Canvas \u6307\u7EB9\uFF08\u5728\u50CF\u7D20\u6570\u636E\u4E2D\u52A0\u5165 seed \u51B3\u5B9A\u7684\u5FAE\u91CF\u566A\u58F0\uFF09\u2500\u2500
  try {
    var _origToBlob = HTMLCanvasElement.prototype.toBlob;
    var _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    var _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

    // \u7ED9 ImageData \u7684\u50CF\u7D20\u52A0\u5FAE\u91CF\u566A\u58F0\uFF08seed \u51B3\u5B9A\uFF0C\u540C seed \u540C\u7ED3\u679C\uFF09
    function _noiseImageData(imageData) {
      var d = imageData.data;
      for (var i = 0; i < d.length; i += 4) {
        // \u6BCF 100 \u4E2A\u50CF\u7D20\u6270\u52A8\u4E00\u6B21\uFF0C\u5E45\u5EA6 \xB11
        if (i % 400 === 0) {
          var n = ((seedRand() * 3) | 0) - 1; // -1, 0, 1
          d[i] = Math.max(0, Math.min(255, d[i] + n));
        }
      }
      return imageData;
    }

    CanvasRenderingContext2D.prototype.getImageData = function() {
      var data = _origGetImageData.apply(this, arguments);
      return _noiseImageData(data);
    };
    HTMLCanvasElement.prototype.toDataURL = function() {
      // \u5728\u5BFC\u51FA\u524D\u6CE8\u5165\u566A\u58F0\u50CF\u7D20
      var ctx = this.getContext('2d');
      if (ctx) {
        try {
          var img = _origGetImageData.call(ctx, 0, 0, this.width, this.height);
          _noiseImageData(img);
          ctx.putImageData(img, 0, 0);
        } catch(e){} // \u8DE8\u57DF canvas \u4F1A\u62A5\u9519\uFF0C\u5FFD\u7565
      }
      return _origToDataURL.apply(this, arguments);
    };
    HTMLCanvasElement.prototype.toBlob = function() {
      var ctx = this.getContext('2d');
      if (ctx) {
        try {
          var img = _origGetImageData.call(ctx, 0, 0, this.width, this.height);
          _noiseImageData(img);
          ctx.putImageData(img, 0, 0);
        } catch(e){}
      }
      return _origToBlob.apply(this, arguments);
    };
  } catch(e){}

  // \u2500\u2500 12. WebGL \u6307\u7EB9\uFF08\u4F2A\u9020 renderer / vendor / unmasked \u4FE1\u606F\uFF09\u2500\u2500
  try {
    var _glRenderers = [
      'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)',
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti, OpenGL 4.5)',
      'ANGLE (AMD, AMD Radeon Pro 5500M, OpenGL 4.1)',
      'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)',
      'ANGLE (Apple, Apple M1, OpenGL 4.1)',
      'ANGLE (Apple, Apple M2, OpenGL 4.1)',
      'ANGLE (Intel, Intel(R) UHD Graphics 770, OpenGL 4.5)',
    ];
    var _glVendors = ['Google Inc. (Intel)', 'Google Inc. (NVIDIA)', 'Google Inc. (AMD)', 'Google Inc. (Apple)'];
    var _myRenderer = _glRenderers[Math.floor(seedRand() * _glRenderers.length)];
    var _myVendor = _glVendors[Math.floor(seedRand() * _glVendors.length)];

    var _origGetParam = WebGLRenderingContext.prototype.getParameter;
    function _fakeGetParam(param) {
      // UNMASKED_VENDOR_WEBGL = 0x9245, UNMASKED_RENDERER_WEBGL = 0x9246
      if (param === 0x9245) return _myVendor;
      if (param === 0x9246) return _myRenderer;
      return _origGetParam.call(this, param);
    }
    WebGLRenderingContext.prototype.getParameter = _fakeGetParam;
    if (typeof WebGL2RenderingContext !== 'undefined') {
      var _origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 0x9245) return _myVendor;
        if (param === 0x9246) return _myRenderer;
        return _origGetParam2.call(this, param);
      };
    }
  } catch(e){}

  // \u2500\u2500 13. AudioContext \u6307\u7EB9\u566A\u58F0 \u2500\u2500
  try {
    var _origCreateOsc = (window.AudioContext || window.webkitAudioContext).prototype.createOscillator;
    var _origCreateDyn = (window.AudioContext || window.webkitAudioContext).prototype.createDynamicsCompressor;
    if (_origCreateDyn) {
      var _OrigAC = window.AudioContext || window.webkitAudioContext;
      var _origGetFloat = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(arr) {
        _origGetFloat.call(this, arr);
        // \u52A0\u5FAE\u91CF\u566A\u58F0
        for (var i = 0; i < arr.length; i += 10) {
          arr[i] = arr[i] + (seedRand() - 0.5) * 0.001;
        }
      };
    }
  } catch(e){}

  // \u2500\u2500 14. ClientRects \u5FAE\u504F\u79FB\uFF08seed \u51B3\u5B9A\u7684\u4E9A\u50CF\u7D20\u504F\u79FB\uFF09\u2500\u2500
  try {
    var _origGetBCR = Element.prototype.getBoundingClientRect;
    var _origGetCR = Element.prototype.getClientRects;
    var _rectNoise = (seedRand() - 0.5) * 0.5; // -0.25 ~ +0.25
    Element.prototype.getBoundingClientRect = function() {
      var r = _origGetBCR.call(this);
      return new DOMRect(r.x + _rectNoise, r.y + _rectNoise, r.width, r.height);
    };
    Element.prototype.getClientRects = function() {
      var rects = _origGetCR.call(this);
      var out = [];
      for (var i = 0; i < rects.length; i++) {
        out.push(new DOMRect(rects[i].x + _rectNoise, rects[i].y + _rectNoise, rects[i].width, rects[i].height));
      }
      return out;
    };
  } catch(e){}

  // \u2500\u2500 15. navigator.permissions.query \u2500\u2500
  try {
    if (navigator.permissions) {
      var _origPQ = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function(p) {
        if (p.name === 'notifications') return Promise.resolve({ state: 'prompt', onchange: null });
        return _origPQ(p);
      };
    }
  } catch(e){}

  // \u2500\u2500 16. Function.prototype.toString \u2500\u2500
  var _ots = Function.prototype.toString;
  var _fts = function() {
    if (this === _fts) return 'function toString() { [native code] }';
    return _ots.call(this);
  };
  Function.prototype.toString = _fts;

  // \u2500\u2500 17. document.hidden / visibilityState \u2500\u2500
  try {
    Object.defineProperty(document, 'hidden', { get: function(){ return false; }, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: function(){ return 'visible'; }, configurable: true });
  } catch(e){}

  // \u2500\u2500 18. connection.rtt \u4E00\u81F4\u6027 \u2500\u2500
  try {
    if (navigator.connection) {
      var _rtt = [50, 100, 150][Math.floor(seedRand() * 3)];
      Object.defineProperty(navigator.connection, 'rtt', { get: function(){ return _rtt; } });
    }
  } catch(e){}

})();
`;
}
function openExternalBrowser(url, appId = DEFAULT_APP_ID) {
  console.log(`[Browser] openExternalBrowser called: url="${url}", appId="${appId}"`);
  const existing = browserInstances.get(appId);
  if (existing && !existing.win.isDestroyed()) {
    const currentUrl = existing.win.webContents.getURL();
    console.log(`[Browser] \u5DF2\u6709\u7A97\u53E3, currentUrl="${currentUrl}"`);
    if (isSameOriginUrl(currentUrl, url)) {
      if (!browserHiddenMode) {
        if (existing.win.isMinimized()) existing.win.restore();
        existing.win.show();
        existing.win.focus();
      }
      return;
    }
    console.log(`[Browser] \u5DF2\u6709\u7A97\u53E3\u5BFC\u822A\u5230: ${url}`);
    existing.win.loadURL(url);
    if (!browserHiddenMode) existing.win.focus();
    return;
  }
  const profile = loadOrCreateProfile(appId);
  const win = new import_electron2.BrowserWindow({
    width: 1920,
    height: 1080,
    show: !browserHiddenMode,
    title: `\u6D4F\u89C8\u5668 [${appId}]`,
    backgroundColor: "#1e1e1e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: `persist:browser-${appId}`
    }
  });
  const instance = {
    win,
    appId,
    seed: profile.seed,
    ua: profile.ua
  };
  browserInstances.set(appId, instance);
  const wc = win.webContents;
  wc.setUserAgent(profile.ua);
  wc.on("certificate-error", (event, certUrl, error, _cert, callback) => {
    console.log(`[Browser] certificate-error: ${error} @ ${certUrl}`);
    event.preventDefault();
    callback(true);
  });
  wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(`[Browser] did-fail-load: code=${errorCode} desc="${errorDescription}" url="${validatedURL}"`);
    sendExternalStatus({
      type: "console",
      appId,
      consoleLevel: "error",
      consoleMessage: `[\u9875\u9762\u52A0\u8F7D\u5931\u8D25] ${validatedURL} \u2014 ${errorCode} ${errorDescription}`
    });
    if (!isMainFrame || !validatedURL) return;
    const errorHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>\u9875\u9762\u52A0\u8F7D\u5931\u8D25</title>
<style>
  body { background: #1e1e1e; color: #ccc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .container { text-align: center; max-width: 500px; }
  h1 { color: #e06c75; font-size: 24px; margin-bottom: 16px; }
  .url { color: #61afef; word-break: break-all; margin: 16px 0; font-size: 14px; background: #282c34; padding: 12px; border-radius: 6px; }
  .error { color: #e5c07b; font-size: 13px; margin: 8px 0; }
  .hint { color: #888; font-size: 13px; margin-top: 20px; line-height: 1.6; }
  button { margin-top: 20px; padding: 8px 24px; background: #61afef; color: #1e1e1e; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
  button:hover { background: #528bce; }
</style>
</head>
<body>
<div class="container">
  <h1>\u26A0 \u9875\u9762\u52A0\u8F7D\u5931\u8D25</h1>
  <div class="url">${validatedURL}</div>
  <div class="error">\u9519\u8BEF\u7801: ${errorCode} \u2014 ${errorDescription}</div>
  <div class="hint">
    ${errorCode === -102 ? "\u8FDE\u63A5\u88AB\u62D2\u7EDD \u2014 \u76EE\u6807\u670D\u52A1\u53EF\u80FD\u672A\u542F\u52A8\uFF0C\u8BF7\u786E\u8BA4\u670D\u52A1\u5DF2\u8FD0\u884C\u5728\u8BE5\u5730\u5740\u3002" : errorCode === -105 ? "\u57DF\u540D\u65E0\u6CD5\u89E3\u6790 \u2014 \u8BF7\u68C0\u67E5\u7F51\u5740\u662F\u5426\u6B63\u786E\u3002" : errorCode === -106 ? "\u65E0\u7F51\u7EDC\u8FDE\u63A5 \u2014 \u8BF7\u68C0\u67E5\u7F51\u7EDC\u8BBE\u7F6E\u3002" : "\u8BF7\u68C0\u67E5\u7F51\u5740\u662F\u5426\u6B63\u786E\u6216\u7A0D\u540E\u91CD\u8BD5\u3002"}
  </div>
  <button onclick="location.href='${validatedURL}'">\u91CD\u8BD5</button>
</div>
</body>
</html>`)}`;
    win.loadURL(errorHtml);
  });
  const stealthScript = buildStealthJS(profile.seed, profile.ua);
  wc.on("dom-ready", () => {
    wc.executeJavaScript(stealthScript).catch(() => {
    });
  });
  wc.setWindowOpenHandler(({ url: newUrl }) => {
    console.log(`[Browser] setWindowOpenHandler: newUrl="${newUrl}"`);
    if (newUrl && newUrl !== "about:blank") {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          console.log(`[Browser] \u91CD\u5B9A\u5411\u5230: ${newUrl}`);
          win.loadURL(newUrl);
        }
      }, 50);
    }
    return { action: "deny" };
  });
  console.log(`[Browser] \u5F00\u59CB\u52A0\u8F7D: ${url}`);
  win.loadURL(url);
  if (browserDebugMode) {
    wc.openDevTools({ mode: "bottom" });
  }
  wc.on("console-message", (event) => {
    const levelMap = {
      info: "info",
      warning: "warn",
      error: "error",
      debug: "log"
    };
    const consoleLevel = levelMap[event.level] ?? "log";
    sendExternalStatus({
      type: "console",
      appId,
      consoleLevel,
      consoleMessage: event.message,
      consoleSource: event.sourceId,
      consoleLine: event.lineNumber
    });
  });
  wc.on("did-navigate", (_e, navUrl) => {
    sendExternalStatus({ type: "navigated", url: navUrl, appId });
  });
  wc.on("did-navigate-in-page", (_e, navUrl) => {
    sendExternalStatus({ type: "navigated", url: navUrl, appId });
  });
  wc.on("page-title-updated", (_e, title) => {
    sendExternalStatus({ type: "title-changed", title, appId });
  });
  win.on("closed", () => {
    try {
      if (wc.debugger?.isAttached()) wc.debugger.detach();
    } catch {
    }
    browserInstances.delete(appId);
    sendExternalStatus({ type: "closed", appId });
  });
  sendExternalStatus({ type: "opened", url, appId });
}
function closeExternalBrowser(appId = DEFAULT_APP_ID) {
  const inst = browserInstances.get(appId);
  if (inst && !inst.win.isDestroyed()) {
    try {
      if (inst.win.webContents.debugger.isAttached()) {
        inst.win.webContents.debugger.detach();
      }
    } catch {
    }
    inst.win.close();
  }
  browserInstances.delete(appId);
}
function navigateExternalBrowser(url, appId = DEFAULT_APP_ID) {
  const inst = browserInstances.get(appId);
  if (inst && !inst.win.isDestroyed()) {
    inst.win.loadURL(url);
    if (!browserHiddenMode) inst.win.focus();
  }
}
function focusExternalBrowser(appId = DEFAULT_APP_ID) {
  const inst = browserInstances.get(appId);
  if (inst && !inst.win.isDestroyed()) {
    if (inst.win.isMinimized()) inst.win.restore();
    inst.win.show();
    inst.win.focus();
  }
}
function getExternalBrowserWin(appId = DEFAULT_APP_ID) {
  const inst = browserInstances.get(appId);
  if (inst && !inst.win.isDestroyed()) return inst.win;
  return null;
}
function getBrowserInstance(appId = DEFAULT_APP_ID) {
  const inst = browserInstances.get(appId);
  if (inst && !inst.win.isDestroyed()) return inst;
  return null;
}

// src/main/mcp.ts
var import_node_child_process2 = require("node:child_process");
var fs2 = __toESM(require("node:fs/promises"), 1);
var path3 = __toESM(require("node:path"), 1);
var import_electron3 = require("electron");
var TACO_DIR = path3.join(import_electron3.app.getPath("home"), ".taco");
var MCP_JSON = path3.join(TACO_DIR, "mcp.json");
var SCREENSHOTS_DIR = path3.join(TACO_DIR, "screenshots");
var BUILTIN_SERVERS = [
  {
    id: "minimax",
    name: "MiniMax",
    description: "\u56FE\u7247\u7406\u89E3 & \u7F51\u7EDC\u641C\u7D22\uFF08\u9700\u8981\u914D\u7F6E API Key\uFF09",
    command: "uvx",
    args: ["minimax-coding-plan-mcp"],
    env: {
      MINIMAX_API_KEY: "",
      MINIMAX_API_HOST: "https://api.minimaxi.com"
    },
    enabled: false,
    builtin: true
  }
];
var servers = /* @__PURE__ */ new Map();
var expandedPath = null;
function getFullPath() {
  if (expandedPath) return expandedPath;
  const currentPath = process.env.PATH ?? "";
  const extraPaths = [
    path3.join(import_electron3.app.getPath("home"), ".local", "bin"),
    // uv/uvx
    path3.join(import_electron3.app.getPath("home"), ".cargo", "bin"),
    // cargo
    "/usr/local/bin",
    "/opt/homebrew/bin",
    // macOS ARM Homebrew
    "/opt/homebrew/sbin"
  ];
  try {
    const shell2 = process.env.SHELL || "/bin/zsh";
    const fullPath = (0, import_node_child_process2.execSync)(`${shell2} -ilc 'echo $PATH'`, {
      encoding: "utf-8",
      timeout: 5e3
    }).trim();
    if (fullPath) {
      expandedPath = fullPath;
      log("MCP_PATH_RESOLVED", { method: "shell", pathLength: fullPath.split(":").length });
      return fullPath;
    }
  } catch (err) {
    log("MCP_PATH_SHELL_FAIL", { error: err instanceof Error ? err.message : String(err) });
  }
  const allPaths = [.../* @__PURE__ */ new Set([...currentPath.split(":"), ...extraPaths])];
  expandedPath = allPaths.join(":");
  log("MCP_PATH_RESOLVED", { method: "fallback", pathLength: allPaths.length });
  return expandedPath;
}
async function ensureDirs() {
  await fs2.mkdir(TACO_DIR, { recursive: true });
  await fs2.mkdir(SCREENSHOTS_DIR, { recursive: true });
}
async function loadConfig() {
  try {
    const data = await fs2.readFile(MCP_JSON, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}
async function saveConfig(configs) {
  await ensureDirs();
  await fs2.writeFile(MCP_JSON, JSON.stringify(configs, null, 2), "utf-8");
}
async function getAllConfigs() {
  const saved = await loadConfig();
  const result = [];
  for (const builtin of BUILTIN_SERVERS) {
    const persisted = saved.find((s) => s.id === builtin.id);
    if (persisted) {
      persisted.command = builtin.command;
      persisted.args = builtin.args;
      persisted.description = builtin.description;
      result.push(persisted);
    } else {
      result.push({ ...builtin });
    }
  }
  for (const s of saved) {
    if (!s.builtin) result.push(s);
  }
  return result;
}
var HEADER_SEPARATOR = Buffer.from("\r\n\r\n");
var CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;
function writeMessage(state, json) {
  const stdin = state.process?.stdin;
  if (!stdin?.writable) return;
  if (state.transportMode === "content-length") {
    const bodyBytes = Buffer.from(json, "utf-8");
    stdin.write(`Content-Length: ${bodyBytes.length}\r
\r
`);
    stdin.write(bodyBytes);
  } else {
    stdin.write(json + "\n");
  }
}
function sendJsonRpc(state, method, params) {
  return new Promise((resolve2, reject) => {
    if (!state.process?.stdin?.writable) {
      reject(new Error("MCP \u670D\u52A1\u5668\u8FDB\u7A0B\u4E0D\u53EF\u7528"));
      return;
    }
    const id = state.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...params !== void 0 ? { params } : {}
    });
    const timer = setTimeout(() => {
      state.pendingRequests.delete(id);
      reject(new Error(`MCP \u8BF7\u6C42\u8D85\u65F6: ${method}`));
    }, 3e4);
    state.pendingRequests.set(id, { resolve: resolve2, reject, timer });
    writeMessage(state, body);
  });
}
function sendNotification(state, method, params) {
  if (!state.process?.stdin?.writable) return;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    ...params !== void 0 ? { params } : {}
  });
  writeMessage(state, body);
}
function processBuffer(state) {
  if (state.transportMode === "unknown" && state.rawBuffer.length > 0) {
    const firstByte = String.fromCharCode(state.rawBuffer[0]);
    if (firstByte === "C" || firstByte === "c") {
      state.transportMode = "content-length";
      log("MCP_TRANSPORT_DETECTED", { serverId: state.config.id, mode: "content-length" });
    } else {
      state.transportMode = "newline";
      log("MCP_TRANSPORT_DETECTED", { serverId: state.config.id, mode: "newline" });
    }
  }
  if (state.transportMode === "content-length") {
    processContentLengthBuffer(state);
  } else {
    processNewlineBuffer(state);
  }
}
function processNewlineBuffer(state) {
  while (true) {
    const newlineIdx = state.rawBuffer.indexOf(10);
    if (newlineIdx < 0) break;
    const line = state.rawBuffer.subarray(0, newlineIdx).toString("utf-8").trim();
    state.rawBuffer = state.rawBuffer.subarray(newlineIdx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(state, msg);
    } catch {
      log("MCP_PARSE_ERROR", { serverId: state.config.id, line: line.slice(0, 300) });
    }
  }
}
function processContentLengthBuffer(state) {
  while (true) {
    const sepIdx = state.rawBuffer.indexOf(HEADER_SEPARATOR);
    if (sepIdx < 0) break;
    const headerStr = state.rawBuffer.subarray(0, sepIdx).toString("utf-8");
    const match = CONTENT_LENGTH_RE.exec(headerStr);
    if (!match) {
      log("MCP_HEADER_ERROR", { serverId: state.config.id, header: headerStr.slice(0, 200) });
      state.rawBuffer = state.rawBuffer.subarray(sepIdx + HEADER_SEPARATOR.length);
      continue;
    }
    const contentLength = parseInt(match[1], 10);
    const bodyStart = sepIdx + HEADER_SEPARATOR.length;
    if (state.rawBuffer.length < bodyStart + contentLength) {
      break;
    }
    const bodyBuf = state.rawBuffer.subarray(bodyStart, bodyStart + contentLength);
    state.rawBuffer = state.rawBuffer.subarray(bodyStart + contentLength);
    const bodyStr = bodyBuf.toString("utf-8");
    try {
      const msg = JSON.parse(bodyStr);
      handleMessage(state, msg);
    } catch {
      log("MCP_PARSE_ERROR", { serverId: state.config.id, body: bodyStr.slice(0, 300) });
    }
  }
}
function handleMessage(state, msg) {
  if (!msg || typeof msg !== "object") return;
  const obj = msg;
  if ("id" in obj && obj.id !== null && obj.id !== void 0) {
    const id = Number(obj.id);
    const pending = state.pendingRequests.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pendingRequests.delete(id);
    if ("error" in obj) {
      const err = obj.error;
      pending.reject(new Error(err.message ?? `MCP error ${err.code ?? "unknown"}`));
    } else {
      pending.resolve(obj.result);
    }
  } else if ("method" in obj) {
    log("MCP_NOTIFICATION", { serverId: state.config.id, method: obj.method });
  }
}
async function startServer(config) {
  const existing = servers.get(config.id);
  if (existing?.status === "running") return existing;
  const state = {
    config,
    process: null,
    tools: [],
    status: "starting",
    nextId: 1,
    pendingRequests: /* @__PURE__ */ new Map(),
    rawBuffer: Buffer.alloc(0),
    transportMode: "unknown"
  };
  servers.set(config.id, state);
  try {
    const emptyKeys = Object.entries(config.env).filter(([key, val]) => key.toLowerCase().includes("api_key") && !val.trim()).map(([key]) => key);
    if (emptyKeys.length > 0) {
      throw new Error(`\u8BF7\u5148\u5728\u8BBE\u7F6E\u4E2D\u914D\u7F6E ${emptyKeys.join(", ")}\uFF0C\u518D\u542F\u7528\u6B64 MCP \u670D\u52A1\u5668`);
    }
    const fullPath = getFullPath();
    const env = {
      ...process.env,
      PATH: fullPath,
      ...config.env
    };
    log("MCP_SPAWNING", {
      serverId: config.id,
      command: config.command,
      args: config.args
    });
    const child = (0, import_node_child_process2.spawn)(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      // 在所有平台使用 shell 模式，确保命令能被正确解析
      shell: true
    });
    state.process = child;
    child.stdout?.on("data", (chunk) => {
      state.rawBuffer = Buffer.concat([state.rawBuffer, chunk]);
      processBuffer(state);
    });
    child.stderr?.on("data", (chunk) => {
      const msg = chunk.toString("utf-8").trim();
      if (msg) log("MCP_STDERR", { serverId: config.id, msg: msg.slice(0, 1e3) });
    });
    child.on("error", (err) => {
      log("MCP_PROCESS_ERROR", { serverId: config.id, error: err.message });
      state.status = "error";
      state.error = err.message;
      if (err.message.includes("ENOENT")) {
        state.error = `\u627E\u4E0D\u5230\u547D\u4EE4 "${config.command}"\u3002\u8BF7\u786E\u4FDD\u5DF2\u5B89\u88C5\uFF08\u5982 uvx \u9700\u5148\u5B89\u88C5 uv: curl -LsSf https://astral.sh/uv/install.sh | sh\uFF09`;
      }
    });
    child.on("exit", (code, signal) => {
      log("MCP_PROCESS_EXIT", { serverId: config.id, code, signal });
      if (state.status !== "error") {
        state.status = "stopped";
        if (code !== 0) {
          state.error = `\u8FDB\u7A0B\u9000\u51FA\uFF0Ccode=${code}${signal ? `, signal=${signal}` : ""}`;
        }
      }
      for (const [, pending] of state.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP \u670D\u52A1\u5668\u8FDB\u7A0B\u5DF2\u9000\u51FA (code=${code})`));
      }
      state.pendingRequests.clear();
    });
    await waitForProcessReady(state, 1e4);
    if (state.status === "error") {
      throw new Error(state.error ?? "\u542F\u52A8\u5931\u8D25");
    }
    log("MCP_HANDSHAKE_START", { serverId: config.id });
    const initResult = await sendJsonRpc(state, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "taco", version: "1.0.0" }
    });
    log("MCP_INIT", { serverId: config.id, result: initResult });
    sendNotification(state, "notifications/initialized");
    const toolsResult = await sendJsonRpc(state, "tools/list");
    state.tools = toolsResult.tools ?? [];
    log("MCP_TOOLS", { serverId: config.id, tools: state.tools.map((t) => t.name) });
    state.status = "running";
    return state;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("MCP_START_FAIL", { serverId: config.id, error: msg });
    state.status = "error";
    state.error = msg;
    try {
      state.process?.kill();
    } catch {
    }
    state.process = null;
    return state;
  }
}
function waitForProcessReady(state, timeoutMs) {
  return new Promise((resolve2) => {
    const startTime = Date.now();
    const check = () => {
      if (state.status === "error") {
        resolve2();
        return;
      }
      if (state.process?.exitCode !== null && state.process?.exitCode !== void 0) {
        state.status = "error";
        state.error = state.error ?? `\u8FDB\u7A0B\u7ACB\u5373\u9000\u51FA (code=${state.process.exitCode})`;
        resolve2();
        return;
      }
      if (state.process?.stdin?.writable) {
        resolve2();
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        state.status = "error";
        state.error = `\u8FDB\u7A0B\u542F\u52A8\u8D85\u65F6 (${timeoutMs}ms)`;
        resolve2();
        return;
      }
      setTimeout(check, 200);
    };
    setTimeout(check, 500);
  });
}
function stopServer(serverId) {
  const state = servers.get(serverId);
  if (!state) return;
  try {
    state.process?.kill();
  } catch {
  }
  state.process = null;
  state.status = "stopped";
  state.tools = [];
  for (const [, pending] of state.pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error("\u670D\u52A1\u5668\u5DF2\u505C\u6B62"));
  }
  state.pendingRequests.clear();
}
async function initMcp() {
  await ensureDirs();
  const configs = await getAllConfigs();
  await saveConfig(configs);
  for (const config of configs) {
    if (config.enabled) {
      startServer(config).catch(
        (err) => log("MCP_INIT_START_FAIL", { id: config.id, error: String(err) })
      );
    }
  }
}
async function listMcpServers() {
  const configs = await getAllConfigs();
  return configs.map((config) => {
    const state = servers.get(config.id);
    return {
      ...config,
      status: state?.status ?? "stopped",
      toolCount: state?.tools.length ?? 0,
      error: state?.error
    };
  });
}
async function saveMcpServer(config) {
  const configs = await getAllConfigs();
  const idx = configs.findIndex((c) => c.id === config.id);
  if (idx >= 0) {
    configs[idx] = config;
  } else {
    configs.push(config);
  }
  await saveConfig(configs);
  stopServer(config.id);
  if (config.enabled) {
    await startServer(config);
  }
}
async function removeMcpServer(serverId) {
  stopServer(serverId);
  servers.delete(serverId);
  const configs = await getAllConfigs();
  const filtered = configs.filter((c) => c.id !== serverId || c.builtin);
  await saveConfig(filtered);
}
async function toggleMcpServer(serverId, enabled) {
  const configs = await getAllConfigs();
  const config = configs.find((c) => c.id === serverId);
  if (!config) throw new Error(`MCP \u670D\u52A1\u5668 ${serverId} \u4E0D\u5B58\u5728`);
  config.enabled = enabled;
  await saveConfig(configs);
  if (enabled) {
    await startServer(config);
  } else {
    stopServer(serverId);
  }
}
function getActiveMcpTools() {
  const tools = [];
  for (const [serverId, state] of servers) {
    if (state.status === "running") {
      for (const tool of state.tools) {
        tools.push({ ...tool, serverId });
      }
    }
  }
  return tools;
}
async function callMcpTool(serverId, toolName, args) {
  const state = servers.get(serverId);
  if (!state || state.status !== "running") {
    throw new Error(`MCP \u670D\u52A1\u5668 ${serverId} \u672A\u8FD0\u884C`);
  }
  const result = await sendJsonRpc(state, "tools/call", {
    name: toolName,
    arguments: args
  });
  return result;
}
async function saveScreenshot(dataUrl, appId) {
  await ensureDirs();
  const base64Match = dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
  if (!base64Match) throw new Error("Invalid screenshot data URL");
  const normalizedAppId = (appId ?? "shared").trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "shared";
  const targetDir = path3.join(SCREENSHOTS_DIR, normalizedAppId);
  await fs2.mkdir(targetDir, { recursive: true });
  const buffer = Buffer.from(base64Match[1], "base64");
  const filename = `screenshot-${Date.now()}.png`;
  const filePath = path3.join(targetDir, filename);
  await fs2.writeFile(filePath, buffer);
  try {
    const files = await fs2.readdir(targetDir);
    const screenshots = files.filter((f) => f.startsWith("screenshot-") && f.endsWith(".png")).sort();
    if (screenshots.length > 20) {
      const toDelete = screenshots.slice(0, screenshots.length - 20);
      for (const f of toDelete) {
        await fs2.unlink(path3.join(targetDir, f)).catch(() => {
        });
      }
    }
  } catch {
  }
  return filePath;
}
function shutdownAllMcp() {
  for (const [id] of servers) {
    stopServer(id);
  }
  servers.clear();
}

// src/main/tools.ts
var toolDefinitions = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "\u8BFB\u53D6\u6307\u5B9A\u8DEF\u5F84\u6587\u4EF6\u7684\u5185\u5BB9\u3002\u7528\u4E8E\u67E5\u770B\u4EE3\u7801\u6587\u4EF6\u3001\u914D\u7F6E\u6587\u4EF6\u3001\u65E5\u5FD7\u7B49\u3002",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "\u6587\u4EF6\u7684\u7EDD\u5BF9\u8DEF\u5F84\u6216\u76F8\u5BF9\u8DEF\u5F84" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "\u5C06\u5185\u5BB9\u5199\u5165\u6307\u5B9A\u8DEF\u5F84\u7684\u6587\u4EF6\u3002\u5982\u679C\u6587\u4EF6\u4E0D\u5B58\u5728\u5219\u521B\u5EFA\uFF0C\u5B58\u5728\u5219\u8986\u76D6\u3002\u7528\u4E8E\u521B\u5EFA\u6216\u4FEE\u6539\u4EE3\u7801\u6587\u4EF6\u3001\u914D\u7F6E\u6587\u4EF6\u7B49\u3002",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "\u6587\u4EF6\u7684\u7EDD\u5BF9\u8DEF\u5F84\u6216\u76F8\u5BF9\u8DEF\u5F84" },
          content: { type: "string", description: "\u8981\u5199\u5165\u7684\u5B8C\u6574\u6587\u4EF6\u5185\u5BB9" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "\u67E5\u770B\u76EE\u5F55\u7ED3\u6784\uFF08\u6811\u5F62\uFF09\u3002\u652F\u6301\u6DF1\u5EA6\u63A7\u5236\u3001\u9690\u85CF\u6587\u4EF6\u8FC7\u6EE4\u548C\u76EE\u5F55/\u6587\u4EF6\u6570\u91CF\u6458\u8981\u3002\u9002\u5408\u5148\u6574\u4F53\u7406\u89E3\u9879\u76EE\u7ED3\u6784\u518D\u5B9A\u4F4D\u76EE\u6807\u6587\u4EF6\u3002",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: '\u76EE\u6807\u76EE\u5F55\uFF08\u76F8\u5BF9\u5DE5\u4F5C\u533A\u6216\u7EDD\u5BF9\u8DEF\u5F84\uFF09\uFF0C\u9ED8\u8BA4 "."' },
          maxDepth: { type: "number", description: "\u6811\u5F62\u5C55\u793A\u6DF1\u5EA6\uFF0C\u9ED8\u8BA4 4\uFF0C\u8303\u56F4 1-12" },
          includeFiles: { type: "boolean", description: "\u662F\u5426\u663E\u793A\u6587\u4EF6\u3002false \u65F6\u4EC5\u663E\u793A\u76EE\u5F55\u9AA8\u67B6\uFF0C\u9ED8\u8BA4 true" },
          showFiles: { type: "boolean", description: "\u517C\u5BB9\u53C2\u6570\uFF0C\u7B49\u4EF7\u4E8E includeFiles" },
          includeHidden: { type: "boolean", description: "\u662F\u5426\u5305\u542B\u9690\u85CF\u6587\u4EF6/\u76EE\u5F55\uFF08\u4EE5 . \u5F00\u5934\uFF09\uFF0C\u9ED8\u8BA4 false" },
          maxEntries: { type: "number", description: "\u626B\u63CF\u4E0A\u9650\uFF0C\u9ED8\u8BA4 4000\uFF0C\u8303\u56F4 200-10000" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "\u5728\u7528\u6237\u7684\u7CFB\u7EDF\u4E0A\u6267\u884C shell \u547D\u4EE4\u3002\u7528\u4E8E\u8FD0\u884C\u6784\u5EFA\u5DE5\u5177\u3001\u5305\u7BA1\u7406\u5668\u3001git \u64CD\u4F5C\u3001\u542F\u52A8\u811A\u672C\u7B49\u3002",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "\u8981\u6267\u884C\u7684 shell \u547D\u4EE4" },
          cwd: { type: "string", description: "\u547D\u4EE4\u6267\u884C\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF08\u53EF\u9009\uFF09" }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "\u5220\u9664\u6307\u5B9A\u8DEF\u5F84\u7684\u6587\u4EF6\u3002\u7528\u4E8E\u6E05\u7406\u4E0D\u9700\u8981\u7684\u6587\u4EF6\u3002\u5220\u9664\u524D\u4F1A\u81EA\u52A8\u4FDD\u5B58\u65E7\u5185\u5BB9\u4EE5\u652F\u6301\u64A4\u9500\u3002",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "\u8981\u5220\u9664\u7684\u6587\u4EF6\u7684\u7EDD\u5BF9\u8DEF\u5F84\u6216\u76F8\u5BF9\u8DEF\u5F84" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "propose_plan",
      description: "\u5411\u7528\u6237\u63D0\u51FA\u6267\u884C\u8BA1\u5212\u5E76\u7B49\u5F85\u786E\u8BA4\u3002\u5F53\u9700\u8981\u6267\u884C\u591A\u6B65\u9AA4\u7684\u4EFB\u52A1\uFF08\u5982\u521B\u5EFA\u9879\u76EE\u3001\u91CD\u6784\u4EE3\u7801\u3001\u67B6\u6784\u53D8\u66F4\u7B49\uFF09\u65F6\uFF0C\u5FC5\u987B\u5148\u8C03\u7528\u6B64\u5DE5\u5177\u5C55\u793A\u8BA1\u5212\uFF0C\u5F97\u5230\u7528\u6237\u786E\u8BA4\u540E\u624D\u80FD\u5F00\u59CB\u6267\u884C\u3002\u5355\u4E2A\u7B80\u5355\u64CD\u4F5C\uFF08\u5982\u8BFB\u53D6\u6587\u4EF6\u3001\u641C\u7D22\u4EE3\u7801\uFF09\u4E0D\u9700\u8981\u8C03\u7528\u6B64\u5DE5\u5177\u3002",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "\u8BA1\u5212\u7684\u7B80\u8981\u6982\u8FF0\uFF08\u4E00\u53E5\u8BDD\uFF09" },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "\u5177\u4F53\u7684\u6267\u884C\u6B65\u9AA4\u5217\u8868"
          },
          reasoning: { type: "string", description: "\u9009\u62E9\u6B64\u65B9\u6848\u7684\u7406\u7531\uFF08\u53EF\u9009\uFF09" }
        },
        required: ["summary", "steps"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_plan_progress",
      description: "\u66F4\u65B0\u5F53\u524D\u6267\u884C\u8BA1\u5212\u4E2D\u67D0\u4E2A\u6B65\u9AA4\u7684\u72B6\u6001\u3002\u5728\u6267\u884C\u8BA1\u5212\u7684\u6BCF\u4E00\u6B65\u4E4B\u524D\u8C03\u7528\uFF08\u8BBE\u4E3A in_progress\uFF09\uFF0C\u5B8C\u6210\u540E\u518D\u6B21\u8C03\u7528\uFF08\u8BBE\u4E3A done \u6216 failed\uFF09\u3002\u6B64\u5DE5\u5177\u81EA\u52A8\u6267\u884C\uFF0C\u65E0\u9700\u7528\u6237\u786E\u8BA4\u3002",
      parameters: {
        type: "object",
        properties: {
          stepIndex: { type: "number", description: "\u6B65\u9AA4\u7684\u7D22\u5F15\uFF08\u4ECE 0 \u5F00\u59CB\uFF0C\u5BF9\u5E94 propose_plan \u4E2D steps \u6570\u7EC4\u7684\u4E0B\u6807\uFF09" },
          status: {
            type: "string",
            enum: ["in_progress", "done", "failed"],
            description: "\u6B65\u9AA4\u7684\u65B0\u72B6\u6001\uFF1Ain_progress=\u6B63\u5728\u6267\u884C\uFF0Cdone=\u5DF2\u5B8C\u6210\uFF0Cfailed=\u6267\u884C\u5931\u8D25"
          },
          note: { type: "string", description: "\u53EF\u9009\u7684\u8FDB\u5EA6\u5907\u6CE8\uFF0C\u5982\u5B8C\u6210\u6458\u8981\u6216\u5931\u8D25\u539F\u56E0" }
        },
        required: ["stepIndex", "status"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_file",
      description: "\u6309\u6587\u4EF6\u540D\u6216\u76F8\u5BF9\u8DEF\u5F84\u67E5\u627E\u6587\u4EF6/\u76EE\u5F55\u3002\u652F\u6301 fuzzy\u3001glob\u3001exact \u4E09\u79CD\u5339\u914D\u6A21\u5F0F\uFF0C\u5E76\u6309\u76F8\u5173\u6027\u6392\u5E8F\u3002",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: '\u641C\u7D22\u6A21\u5F0F\uFF0C\u5982 "App.tsx"\u3001"src/**/App.tsx"\u3001"agent"\uFF08\u5FC5\u586B\uFF09' },
          directory: { type: "string", description: '\u9650\u5B9A\u641C\u7D22\u76EE\u5F55\uFF0C\u9ED8\u8BA4 "."' },
          type: { type: "string", enum: ["file", "directory", "all"], description: "\u641C\u7D22\u7C7B\u578B\uFF0C\u9ED8\u8BA4 file" },
          mode: { type: "string", enum: ["auto", "fuzzy", "glob", "exact"], description: "\u5339\u914D\u6A21\u5F0F\u3002auto \u4F1A\u81EA\u52A8\u8BC6\u522B\uFF08\u542B * ? {} \u8D70 glob\uFF0C\u5426\u5219 fuzzy\uFF09" },
          includeHidden: { type: "boolean", description: "\u662F\u5426\u5305\u542B\u9690\u85CF\u6587\u4EF6/\u76EE\u5F55\uFF0C\u9ED8\u8BA4 false" },
          maxResults: { type: "number", description: "\u6700\u5927\u8FD4\u56DE\u6761\u6570\uFF0C\u9ED8\u8BA4 50\uFF0C\u8303\u56F4 1-200" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "\u5728\u6587\u4EF6\u5185\u5BB9\u4E2D\u641C\u7D22\u5173\u952E\u8BCD\u6216\u6B63\u5219\u8868\u8FBE\u5F0F\uFF0C\u8FD4\u56DE\u5339\u914D\u884C\u53CA\u4E0A\u4E0B\u6587\u3002\u4F18\u5148\u4F7F\u7528 rg (ripgrep)\uFF0C\u81EA\u52A8\u5C0A\u91CD .gitignore\u3002\u7ED3\u679C\u6309\u6587\u4EF6\u5206\u7EC4\uFF0C\u7D27\u51D1\u9AD8\u6548\u3002\u7528\u4E8E\u5728\u4EE3\u7801\u4E2D\u5B9A\u4F4D\u51FD\u6570\u3001\u53D8\u91CF\u3001\u914D\u7F6E\u7B49\u3002",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "\u641C\u7D22\u5173\u952E\u8BCD\u6216\u6B63\u5219\u8868\u8FBE\u5F0F" },
          directory: { type: "string", description: "\u641C\u7D22\u76EE\u5F55\uFF08\u53EF\u9009\uFF0C\u9ED8\u8BA4\u9879\u76EE\u6839\u76EE\u5F55\uFF09" },
          filePattern: { type: "string", description: '\u9650\u5B9A\u6587\u4EF6\u7C7B\u578B\uFF0C\u5982 "*.ts"\u3001"*.{ts,tsx}"\uFF08\u53EF\u9009\uFF09' },
          contextLines: { type: "number", description: "\u6BCF\u4E2A\u5339\u914D\u9879\u663E\u793A\u7684\u4E0A\u4E0B\u6587\u884C\u6570\uFF0C\u9ED8\u8BA4 2" },
          maxResults: { type: "number", description: "\u6700\u5927\u8FD4\u56DE\u5339\u914D\u6570\uFF0C\u9ED8\u8BA4 30" },
          caseSensitive: { type: "boolean", description: "\u662F\u5426\u533A\u5206\u5927\u5C0F\u5199\uFF0C\u9ED8\u8BA4 false" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_note",
      description: "\u4FDD\u5B58\u4E00\u6761\u9879\u76EE\u7B14\u8BB0/\u8BB0\u5FC6\u5230\u6301\u4E45\u5316\u5B58\u50A8\u3002\u5728\u5BF9\u8BDD\u8FC7\u7A0B\u4E2D\uFF0C\u5F53\u4F60\u4ECE\u7528\u6237\u6D88\u606F\u3001\u4EE3\u7801\u6587\u4EF6\u3001\u6267\u884C\u7ED3\u679C\u4E2D\u8BC6\u522B\u5230\u91CD\u8981\u7684\u9879\u76EE\u4E0A\u4E0B\u6587\u4FE1\u606F\u65F6\uFF08\u5982\u4EE3\u7801\u89C4\u8303\u3001\u6570\u636E\u5E93\u914D\u7F6E\u3001\u67B6\u6784\u51B3\u7B56\u3001\u6280\u672F\u6808\u504F\u597D\u3001\u56E2\u961F\u7EA6\u5B9A\u7B49\uFF09\uFF0C\u5E94\u7ACB\u5373\u4E14\u4E3B\u52A8\u8C03\u7528\u6B64\u5DE5\u5177\u8BB0\u5F55\u3002\u7B14\u8BB0\u4F1A\u5728\u540E\u7EED\u6240\u6709\u4F1A\u8BDD\u4E2D\u81EA\u52A8\u6CE8\u5165\u7CFB\u7EDF\u63D0\u793A\u8BCD\uFF0C\u8BA9 AI \u59CB\u7EC8\u4E86\u89E3\u9879\u76EE\u80CC\u666F\u3002\u65E0\u9700\u5F81\u6C42\u7528\u6237\u8BB8\u53EF\u5373\u53EF\u8C03\u7528\u3002",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "\u7B14\u8BB0\u6807\u9898\uFF08\u7B80\u6D01\u6982\u62EC\uFF09" },
          content: { type: "string", description: "\u7B14\u8BB0\u6B63\u6587\u5185\u5BB9\uFF08\u8BE6\u7EC6\u63CF\u8FF0\uFF09" },
          category: {
            type: "string",
            enum: ["convention", "credential", "architecture", "config", "other"],
            description: "\u5206\u7C7B\uFF1Aconvention(\u4EE3\u7801\u89C4\u8303), credential(\u51ED\u8BC1/\u8D26\u53F7), architecture(\u67B6\u6784\u8BBE\u8BA1), config(\u914D\u7F6E\u4FE1\u606F), other(\u5176\u4ED6)"
          }
        },
        required: ["title", "content", "category"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description: "\u5220\u9664\u4E00\u6761\u9879\u76EE\u7B14\u8BB0/\u8BB0\u5FC6\u3002\u5F53\u7528\u6237\u8981\u6C42\u5220\u9664\u67D0\u6761\u7B14\u8BB0\u6216\u67D0\u9879\u8BB0\u5FC6\u5DF2\u8FC7\u65F6\u65F6\u4F7F\u7528\u3002",
      parameters: {
        type: "object",
        properties: {
          noteId: { type: "string", description: "\u8981\u5220\u9664\u7684\u7B14\u8BB0 ID" }
        },
        required: ["noteId"]
      }
    }
  },
  /* ---- 浏览器自动化工具 ---- */
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description: "\u5728\u5916\u90E8\u6D4F\u89C8\u5668\u7A97\u53E3\u4E2D\u6253\u5F00/\u5BFC\u822A\u5230\u6307\u5B9A URL\u3002\u5982\u679C\u6D4F\u89C8\u5668\u672A\u6253\u5F00\u4F1A\u81EA\u52A8\u6253\u5F00\u3002\u53EF\u901A\u8FC7 appId \u6307\u5B9A\u64CD\u4F5C\u54EA\u4E2A\u6D4F\u89C8\u5668\u5B9E\u4F8B\uFF08\u4E0D\u540C appId \u62E5\u6709\u72EC\u7ACB\u7684\u6307\u7EB9\u548C\u4F1A\u8BDD\uFF09\u3002",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "\u8981\u5BFC\u822A\u5230\u7684 URL\uFF08\u652F\u6301 http/https\uFF09" },
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\u3002\u4E0D\u540C appId \u5BF9\u5E94\u72EC\u7ACB\u7684\u6D4F\u89C8\u5668\u7A97\u53E3\u3001\u4F1A\u8BDD\u548C\u6307\u7EB9\u3002\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description: "\u622A\u53D6\u5F53\u524D\u6D4F\u89C8\u5668\u9875\u9762\u7684\u622A\u56FE\u5E76\u83B7\u53D6\u9875\u9762\u5143\u7D20\u4FE1\u606F\u3002\u8FD4\u56DE\u5305\u542B\u9875\u9762\u6807\u9898\u3001URL\u3001\u53EF\u89C1\u5143\u7D20\u5217\u8868\u7684\u7ED3\u6784\u5316\u4FE1\u606F\u3002",
      parameters: {
        type: "object",
        properties: {
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\uFF0C\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "\u901A\u8FC7 CDP \u6A21\u62DF\u9F20\u6807\u70B9\u51FB\u9875\u9762\u4E0A\u6307\u5B9A\u7684\u5143\u7D20\u3002\u652F\u6301 CSS \u9009\u62E9\u5668\u6216\u76F4\u63A5\u5750\u6807\u4E24\u79CD\u5B9A\u4F4D\u65B9\u5F0F\u3002\u4F1A\u6A21\u62DF\u9F20\u6807\u79FB\u52A8\u2192\u6309\u4E0B\u2192\u91CA\u653E\u7684\u5B8C\u6574\u64CD\u4F5C\u3002\u53EF\u9009\u53CC\u51FB\u3001\u53F3\u952E\u70B9\u51FB\u3002",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: 'CSS \u9009\u62E9\u5668\u5B9A\u4F4D\u5143\u7D20\uFF0C\u5982 "#login-btn", ".submit"\u3002\u4E0E x/y \u5750\u6807\u4E8C\u9009\u4E00' },
          x: { type: "number", description: "\u76F4\u63A5\u6307\u5B9A\u70B9\u51FB\u7684 X \u5750\u6807\uFF08\u89C6\u53E3\u50CF\u7D20\uFF09\u3002\u9700\u4E0E y \u914D\u5408\u4F7F\u7528" },
          y: { type: "number", description: "\u76F4\u63A5\u6307\u5B9A\u70B9\u51FB\u7684 Y \u5750\u6807\uFF08\u89C6\u53E3\u50CF\u7D20\uFF09\u3002\u9700\u4E0E x \u914D\u5408\u4F7F\u7528" },
          button: { type: "string", enum: ["left", "right", "middle"], description: "\u9F20\u6807\u6309\u952E\uFF0C\u9ED8\u8BA4 left" },
          clickCount: { type: "number", description: "\u70B9\u51FB\u6B21\u6570\uFF0C2 \u4E3A\u53CC\u51FB\uFF0C\u9ED8\u8BA4 1" },
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\uFF0C\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description: "\u901A\u8FC7 CDP \u6A21\u62DF\u952E\u76D8\u9010\u5B57\u7B26\u8F93\u5165\u6587\u5B57\u5230\u6307\u5B9A\u8F93\u5165\u6846\u3002\u6A21\u62DF\u5B8C\u6574\u6D41\u7A0B\uFF1A\u9F20\u6807\u79FB\u52A8\u5230\u5143\u7D20 \u2192 \u70B9\u51FB\u805A\u7126 \u2192 \u6E05\u7A7A\u65E7\u5185\u5BB9 \u2192 \u9010\u5B57\u7B26\u6309\u952E\u8F93\u5165\uFF08\u5E26\u968F\u673A\u5EF6\u8FDF\u6A21\u62DF\u771F\u4EBA\u6253\u5B57\u8282\u594F\uFF09\u3002\u652F\u6301\u4E2D\u6587\u7B49\u975E ASCII \u5B57\u7B26\u3002",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: 'CSS \u9009\u62E9\u5668\uFF0C\u7528\u4E8E\u5B9A\u4F4D\u8F93\u5165\u5143\u7D20\uFF0C\u5982 "#username", "input[name=email]", "#kw"' },
          text: { type: "string", description: "\u8981\u8F93\u5165\u7684\u6587\u5B57" },
          clear: { type: "boolean", description: "\u662F\u5426\u5728\u8F93\u5165\u524D\u6E05\u7A7A\u5DF2\u6709\u5185\u5BB9\uFF0C\u9ED8\u8BA4 true" },
          submit: { type: "boolean", description: "\u8F93\u5165\u5B8C\u6210\u540E\u662F\u5426\u6A21\u62DF\u6309\u4E0B Enter \u952E\u63D0\u4EA4\uFF08\u9002\u7528\u4E8E\u641C\u7D22\u6846\u7B49\u573A\u666F\uFF09\uFF0C\u9ED8\u8BA4 false" },
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\uFF0C\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        },
        required: ["selector", "text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_scroll",
      description: "\u901A\u8FC7 CDP \u6A21\u62DF\u9F20\u6807\u6EDA\u8F6E\u6EDA\u52A8\u6D4F\u89C8\u5668\u9875\u9762\u6216\u6307\u5B9A\u5143\u7D20\u3002\u4F1A\u5206\u591A\u6B65\u5E73\u6ED1\u6EDA\u52A8\u6A21\u62DF\u771F\u5B9E\u6EDA\u8F6E\u64CD\u4F5C\u3002\u53EF\u6307\u5B9A\u5143\u7D20\u8FDB\u884C\u5C40\u90E8\u6EDA\u52A8\u3002",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "\u6EDA\u52A8\u65B9\u5411\uFF0C\u9ED8\u8BA4 down" },
          amount: { type: "number", description: "\u6EDA\u52A8\u50CF\u7D20\u6570\uFF0C\u9ED8\u8BA4 300" },
          selector: { type: "string", description: "\u53EF\u9009\uFF0C\u6307\u5B9A\u9F20\u6807\u79FB\u5230\u8BE5\u5143\u7D20\u4E0A\u65B9\u518D\u6EDA\u52A8\uFF08\u7528\u4E8E\u5C40\u90E8\u53EF\u6EDA\u52A8\u5BB9\u5668\uFF09\u3002\u4E0D\u63D0\u4F9B\u5219\u5728\u9875\u9762\u4E2D\u5FC3\u6EDA\u52A8" },
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\uFF0C\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_get_content",
      description: "\u83B7\u53D6\u9875\u9762\u6216\u6307\u5B9A\u5143\u7D20\u7684\u6587\u672C/HTML \u5185\u5BB9\u3002\u7528\u4E8E\u63D0\u53D6\u9875\u9762\u6570\u636E\u3001\u9A8C\u8BC1\u663E\u793A\u5185\u5BB9\u3002",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "\u53EF\u9009\u7684 CSS \u9009\u62E9\u5668\u3002\u4E0D\u63D0\u4F9B\u5219\u83B7\u53D6 body \u5185\u5BB9" },
          type: { type: "string", enum: ["text", "html", "value"], description: "\u5185\u5BB9\u7C7B\u578B\uFF1Atext(\u7EAF\u6587\u672C)\u3001html(HTML\u6E90\u7801)\u3001value(\u8868\u5355\u503C)\uFF0C\u9ED8\u8BA4 text" },
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\uFF0C\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_wait",
      description: "\u7B49\u5F85\u6307\u5B9A\u7684 CSS \u9009\u62E9\u5668\u5BF9\u5E94\u7684\u5143\u7D20\u51FA\u73B0\u5728\u9875\u9762\u4E2D\u3002\u7528\u4E8E\u7B49\u5F85\u52A8\u6001\u5185\u5BB9\u52A0\u8F7D\u3002",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF0C\u7B49\u5F85\u8BE5\u5143\u7D20\u51FA\u73B0" },
          timeout: { type: "number", description: "\u8D85\u65F6\u6BEB\u79D2\u6570\uFF0C\u9ED8\u8BA4 5000" },
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\uFF0C\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        },
        required: ["selector"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_evaluate",
      description: "\u5728\u6D4F\u89C8\u5668\u9875\u9762\u4E2D\u6267\u884C\u4EFB\u610F JavaScript \u4EE3\u7801\u3002\u8FD4\u56DE\u6267\u884C\u7ED3\u679C\u3002\u7528\u4E8E\u590D\u6742\u7684\u9875\u9762\u4EA4\u4E92\u3001\u6570\u636E\u63D0\u53D6\u3001\u6216\u9A8C\u8BC1\u64CD\u4F5C\u3002",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "\u8981\u6267\u884C\u7684 JavaScript \u8868\u8FBE\u5F0F\u6216\u4EE3\u7801" },
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\uFF0C\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        },
        required: ["expression"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_get_info",
      description: "\u83B7\u53D6\u5F53\u524D\u6D4F\u89C8\u5668\u9875\u9762\u7684\u57FA\u672C\u4FE1\u606F\uFF0C\u5305\u62EC URL\u3001\u6807\u9898\u3001\u89C6\u53E3\u5927\u5C0F\u7B49\u3002",
      parameters: {
        type: "object",
        properties: {
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\uFF0C\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_hover",
      description: "\u901A\u8FC7 CDP \u6A21\u62DF\u9F20\u6807\u79FB\u52A8\u5E76\u60AC\u505C\u5728\u9875\u9762\u4E0A\u6307\u5B9A\u7684\u5143\u7D20\u4E0A\u3002\u89E6\u53D1\u8BE5\u5143\u7D20\u7684 hover \u6548\u679C\uFF08\u5982 tooltip\u3001\u4E0B\u62C9\u83DC\u5355\u7B49\uFF09\u3002\u652F\u6301 CSS \u9009\u62E9\u5668\u6216\u5750\u6807\u3002",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\u5B9A\u4F4D\u5143\u7D20\u3002\u4E0E x/y \u4E8C\u9009\u4E00" },
          x: { type: "number", description: "\u76F4\u63A5\u6307\u5B9A\u60AC\u505C\u7684 X \u5750\u6807" },
          y: { type: "number", description: "\u76F4\u63A5\u6307\u5B9A\u60AC\u505C\u7684 Y \u5750\u6807" },
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\uFF0C\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_keypress",
      description: "\u901A\u8FC7 CDP \u6A21\u62DF\u952E\u76D8\u6309\u952E\u64CD\u4F5C\u3002\u5728\u5F53\u524D\u805A\u7126\u7684\u5143\u7D20\u4E0A\u6309\u4E0B\u952E\u76D8\u6309\u952E\u3002\u652F\u6301\u7279\u6B8A\u952E\uFF08Tab\u3001Escape\u3001Enter\u3001ArrowUp/Down/Left/Right\u3001Backspace\u3001Delete \u7B49\uFF09\u548C\u7EC4\u5408\u952E\uFF08Ctrl+C\u3001Cmd+V \u7B49\uFF09\u3002\u6A21\u62DF\u5B8C\u6574\u7684 keyDown + keyUp \u5E8F\u5217\u3002",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: '\u6309\u952E\u540D\u79F0\uFF0C\u5982 "Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Backspace", "Delete", "Space", "a", "1" \u7B49\u3002\u5BF9\u5E94 KeyboardEvent.key'
          },
          modifiers: {
            type: "array",
            items: { type: "string", enum: ["ctrl", "alt", "shift", "meta"] },
            description: '\u4FEE\u9970\u952E\u5217\u8868\uFF0C\u5982 ["ctrl", "shift"] \u8868\u793A Ctrl+Shift \u7EC4\u5408\u952E\u3002meta \u5728 macOS \u4E0A\u662F Cmd \u952E'
          },
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\uFF0C\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        },
        required: ["key"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_drag",
      description: "\u901A\u8FC7 CDP \u6A21\u62DF\u9F20\u6807\u62D6\u62FD\u64CD\u4F5C\uFF1A\u9F20\u6807\u79FB\u5230\u8D77\u70B9 \u2192 \u6309\u4E0B \u2192 \u591A\u6B65\u5E73\u6ED1\u79FB\u52A8\u5230\u7EC8\u70B9 \u2192 \u91CA\u653E\u3002\u53EF\u7528\u9009\u62E9\u5668\u6216\u5750\u6807\u6307\u5B9A\u8D77\u70B9\u548C\u7EC8\u70B9\u3002",
      parameters: {
        type: "object",
        properties: {
          fromSelector: { type: "string", description: "\u8D77\u70B9\u5143\u7D20 CSS \u9009\u62E9\u5668\u3002\u4E0E fromX/fromY \u4E8C\u9009\u4E00" },
          fromX: { type: "number", description: "\u8D77\u70B9 X \u5750\u6807" },
          fromY: { type: "number", description: "\u8D77\u70B9 Y \u5750\u6807" },
          toSelector: { type: "string", description: "\u7EC8\u70B9\u5143\u7D20 CSS \u9009\u62E9\u5668\u3002\u4E0E toX/toY \u4E8C\u9009\u4E00" },
          toX: { type: "number", description: "\u7EC8\u70B9 X \u5750\u6807" },
          toY: { type: "number", description: "\u7EC8\u70B9 Y \u5750\u6807" },
          steps: { type: "number", description: "\u62D6\u62FD\u63D2\u503C\u6B65\u6570\uFF08\u8D8A\u591A\u8D8A\u5E73\u6ED1\uFF09\uFF0C\u9ED8\u8BA4 10" },
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\uFF0C\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "browser_select",
      description: "\u901A\u8FC7 CDP \u6A21\u62DF\u64CD\u4F5C\u9009\u62E9 <select> \u4E0B\u62C9\u6846\u4E2D\u7684\u9009\u9879\u3002\u6A21\u62DF\u6D41\u7A0B\uFF1A\u9F20\u6807\u79FB\u52A8\u5230\u4E0B\u62C9\u6846 \u2192 \u70B9\u51FB\u6253\u5F00 \u2192 \u952E\u76D8\u4E0A\u4E0B\u7BAD\u5934\u5BFC\u822A \u2192 \u56DE\u8F66\u786E\u8BA4\u9009\u62E9\u3002\u901A\u8FC7 value \u6216\u663E\u793A\u6587\u672C\u5339\u914D\u9009\u9879\u3002",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS \u9009\u62E9\u5668\u5B9A\u4F4D <select> \u5143\u7D20" },
          value: { type: "string", description: "\u9009\u9879\u7684 value \u5C5E\u6027\u503C\uFF08\u4F18\u5148\u5339\u914D\uFF09" },
          label: { type: "string", description: "\u9009\u9879\u7684\u663E\u793A\u6587\u672C\uFF08value \u672A\u5339\u914D\u65F6\u4F7F\u7528\uFF09" },
          appId: { type: "string", description: '\u6D4F\u89C8\u5668\u5B9E\u4F8B\u6807\u8BC6\uFF0C\u4E0D\u6307\u5B9A\u5219\u4F7F\u7528 "default"' }
        },
        required: ["selector"]
      }
    }
  },
  /* ---- MCP 工具调用 ---- */
  {
    type: "function",
    function: {
      name: "mcp_call",
      description: "\u8C03\u7528 MCP (Model Context Protocol) \u670D\u52A1\u5668\u63D0\u4F9B\u7684\u5DE5\u5177\u3002\u4F7F\u7528\u524D\u5148\u901A\u8FC7 mcp_list_tools \u67E5\u770B\u53EF\u7528\u5DE5\u5177\u3002",
      parameters: {
        type: "object",
        properties: {
          server_id: { type: "string", description: 'MCP \u670D\u52A1\u5668 ID\uFF08\u5982 "minimax"\uFF09' },
          tool_name: { type: "string", description: '\u8981\u8C03\u7528\u7684 MCP \u5DE5\u5177\u540D\u79F0\uFF08\u5982 "web_search", "understand_image"\uFF09' },
          arguments: {
            type: "object",
            description: "\u4F20\u9012\u7ED9 MCP \u5DE5\u5177\u7684\u53C2\u6570\uFF08JSON \u5BF9\u8C61\uFF09"
          }
        },
        required: ["server_id", "tool_name", "arguments"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "mcp_list_tools",
      description: "\u5217\u51FA\u6240\u6709\u5DF2\u542F\u7528\u7684 MCP \u670D\u52A1\u5668\u53CA\u5176\u63D0\u4F9B\u7684\u5DE5\u5177\u3002\u7528\u4E8E\u53D1\u73B0\u53EF\u7528\u7684 MCP \u5DE5\u5177\u3002",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  }
];
function getAllToolDefinitions() {
  return [...toolDefinitions];
}
function makeAbortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}
function isAbortError(err) {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message === "Aborted";
}
function resolveSafe(workspace, filePath) {
  const normalizedWs = import_node_path4.default.normalize(workspace);
  if (import_node_path4.default.isAbsolute(filePath)) {
    const normalizedFp = import_node_path4.default.normalize(filePath);
    if (normalizedFp.startsWith(normalizedWs + import_node_path4.default.sep) || normalizedFp === normalizedWs) {
      return { resolved: normalizedFp };
    }
  }
  let cleaned = filePath;
  cleaned = cleaned.replace(/^\/+/, "");
  const wsName = import_node_path4.default.basename(workspace);
  if (cleaned.startsWith(wsName + "/") || cleaned.startsWith(wsName + "\\")) {
    const without = cleaned.slice(wsName.length + 1);
    const testResolved = import_node_path4.default.resolve(workspace, without);
    if (testResolved.startsWith(normalizedWs)) {
      cleaned = without;
    }
  }
  cleaned = cleaned.replace(/\/+$/, "");
  if (!cleaned) cleaned = ".";
  const resolved = import_node_path4.default.resolve(workspace, cleaned);
  const normalized = import_node_path4.default.normalize(resolved);
  if (!normalized.startsWith(normalizedWs)) {
    return { error: `\u5B89\u5168\u9650\u5236\uFF1A\u8DEF\u5F84 "${filePath}" \u8D85\u51FA\u5DE5\u4F5C\u7A7A\u95F4 "${workspace}"\uFF08\u89E3\u6790\u4E3A ${normalized}\uFF09` };
  }
  return { resolved: normalized };
}
async function resolveSmartPath(workspace, filePath, kind = "any") {
  const check = resolveSafe(workspace, filePath);
  if ("error" in check) return check;
  try {
    const stat2 = await import_promises2.default.stat(check.resolved);
    if (kind === "directory" && !stat2.isDirectory()) {
    } else if (kind === "file" && !stat2.isFile()) {
    } else {
      return { resolved: check.resolved };
    }
  } catch {
  }
  const searchName = filePath.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!searchName || searchName === ".") return { error: `\u8DEF\u5F84\u4E0D\u5B58\u5728: ${filePath}` };
  let candidates = [];
  try {
    const { stdout } = await execAsync(
      "git ls-files --cached --others --exclude-standard",
      { cwd: workspace, timeout: 5e3, maxBuffer: 4 * 1024 * 1024 }
    );
    const allFiles = stdout.trim().split("\n").filter(Boolean);
    if (kind === "file" || kind === "any") {
      candidates = allFiles.filter(
        (f) => f === searchName || f.endsWith("/" + searchName)
      );
    }
    if ((kind === "directory" || kind === "any") && candidates.length === 0) {
      const dirs = /* @__PURE__ */ new Set();
      for (const f of allFiles) {
        const parts = f.split("/");
        for (let i = 1; i < parts.length; i++) {
          dirs.add(parts.slice(0, i).join("/"));
        }
      }
      candidates = [...dirs].filter(
        (d) => d === searchName || d.endsWith("/" + searchName)
      );
    }
  } catch {
    try {
      const found = [];
      const IGNORE = /* @__PURE__ */ new Set([".git", "node_modules", ".next", "__pycache__", ".venv", "dist", ".cache", ".turbo", "coverage", "release"]);
      async function scan(dir, depth) {
        if (depth > 8 || found.length >= 5) return;
        const items = await import_promises2.default.readdir(dir, { withFileTypes: true });
        for (const item of items) {
          if (IGNORE.has(item.name)) continue;
          const rel = import_node_path4.default.relative(workspace, import_node_path4.default.join(dir, item.name));
          if (item.isDirectory()) {
            if (rel === searchName || rel.endsWith("/" + searchName) || rel.endsWith(import_node_path4.default.sep + searchName)) {
              found.push(rel);
            }
            await scan(import_node_path4.default.join(dir, item.name), depth + 1);
          } else if (kind !== "directory") {
            if (rel === searchName || rel.endsWith("/" + searchName) || rel.endsWith(import_node_path4.default.sep + searchName)) {
              found.push(rel);
            }
          }
        }
      }
      await scan(workspace, 0);
      candidates = found;
    } catch {
    }
  }
  if (candidates.length === 0) {
    let topDirs = "";
    try {
      const items = await import_promises2.default.readdir(workspace, { withFileTypes: true });
      const dirs = items.filter((i) => i.isDirectory() && !i.name.startsWith(".")).map((i) => i.name + "/").slice(0, 20);
      if (dirs.length > 0) topDirs = `
\u5DE5\u4F5C\u7A7A\u95F4\u9876\u5C42\u76EE\u5F55: ${dirs.join(", ")}`;
    } catch {
    }
    return { error: `\u8DEF\u5F84\u4E0D\u5B58\u5728: "${filePath}"\uFF08\u5728\u5DE5\u4F5C\u7A7A\u95F4 "${workspace}" \u4E2D\u672A\u627E\u5230\u5339\u914D\u7684 "${searchName}"\uFF09${topDirs}
\u8BF7\u4F7F\u7528\u76F8\u5BF9\u4E8E\u5DE5\u4F5C\u7A7A\u95F4\u6839\u76EE\u5F55\u7684\u8DEF\u5F84\uFF0C\u5982 "src/components" \u800C\u975E "components"` };
  }
  candidates.sort((a, b) => a.length - b.length);
  const best = candidates[0];
  const bestResolved = import_node_path4.default.resolve(workspace, best);
  if (!import_node_path4.default.normalize(bestResolved).startsWith(import_node_path4.default.normalize(workspace))) {
    return { error: `\u5B89\u5168\u9650\u5236\uFF1A\u7EA0\u6B63\u540E\u8DEF\u5F84\u8D85\u51FA\u5DE5\u4F5C\u7A7A\u95F4` };
  }
  const hint = candidates.length > 1 ? `
\uFF08\u8FD8\u6709\u5176\u4ED6\u5339\u914D: ${candidates.slice(1, 4).join(", ")}${candidates.length > 4 ? "..." : ""}\uFF09` : "";
  return { resolved: bestResolved, corrected: best + hint };
}
function execAsync(command, options) {
  return new Promise((resolve2, reject) => {
    if (options.signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    let settled = false;
    const child = (0, import_node_child_process3.exec)(command, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      encoding: "utf-8"
    }, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) {
        const error = err;
        error.stdout = stdout ?? "";
        error.stderr = stderr ?? "";
        reject(error);
      } else {
        resolve2({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    });
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }, options.timeout + 5e3);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
      }
      cleanup();
      reject(makeAbortError());
    };
    const cleanup = () => {
      clearTimeout(killTimer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    };
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
    child.on("exit", cleanup);
    child.on("error", cleanup);
  });
}
async function executeTool(name, args, workspace, signal, projectId) {
  try {
    if (signal?.aborted) throw makeAbortError();
    switch (name) {
      case "read_file":
        return await execReadFile(args, workspace);
      case "write_file":
        return await execWriteFile(args, workspace);
      case "delete_file":
        return await execDeleteFile(args, workspace);
      case "list_directory":
        return await execListDirectory(args, workspace);
      case "run_command":
        return await execRunCommand(args, workspace, signal);
      case "find_file":
        return await execFindFile(args, workspace);
      case "search_files":
        return await execSearchFiles(args, workspace);
      case "save_note":
        return await execSaveNote(args, workspace, projectId);
      case "delete_note":
        return await execDeleteNote(args, workspace, projectId);
      /* ---- 浏览器自动化 ---- */
      case "browser_navigate":
        return await execBrowserAction("navigate", args);
      case "browser_screenshot":
        return await execBrowserAction("screenshot", args);
      case "browser_click":
        return await execBrowserAction("click", args);
      case "browser_type":
        return await execBrowserAction("type", args);
      case "browser_scroll":
        return await execBrowserAction("scroll", args);
      case "browser_get_content":
        return await execBrowserAction("get_content", args);
      case "browser_wait":
        return await execBrowserAction("wait", args);
      case "browser_evaluate":
        return await execBrowserAction("evaluate", args);
      case "browser_get_info":
        return await execBrowserAction("get_info", args);
      case "browser_hover":
        return await execBrowserAction("hover", args);
      case "browser_keypress":
        return await execBrowserAction("keypress", args);
      case "browser_drag":
        return await execBrowserAction("drag", args);
      case "browser_select":
        return await execBrowserAction("select", args);
      /* ---- MCP ---- */
      case "mcp_call":
        return await execMcpCall(args, signal);
      case "mcp_list_tools":
        return await execMcpListTools();
      default:
        return { content: `Unknown tool: ${name}`, success: false };
    }
  } catch (err) {
    if (isAbortError(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, success: false };
  }
}
async function execReadFile(args, workspace) {
  const filePath = String(args.path ?? "");
  if (!filePath) return { content: "Error: path is required", success: false };
  const check = await resolveSmartPath(workspace, filePath, "file");
  if ("error" in check) return { content: check.error, success: false };
  const resolved = check.resolved;
  const correctedNote = check.corrected ? `[\u81EA\u52A8\u7EA0\u6B63\u8DEF\u5F84: "${filePath}" \u2192 "${check.corrected.split("\n")[0]}"]
` : "";
  try {
    const stat2 = await import_promises2.default.stat(resolved);
    if (!stat2.isFile()) return { content: `Error: Not a file: ${resolved}`, success: false };
    if (stat2.size > 1024 * 1024) return { content: `Error: File too large (${(stat2.size / 1024 / 1024).toFixed(1)}MB), max 1MB`, success: false };
    const content = await import_promises2.default.readFile(resolved, "utf-8");
    return { content: correctedNote + content, success: true };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { content: `Error: File not found: ${resolved}`, success: false };
    }
    throw err;
  }
}
async function execWriteFile(args, workspace) {
  const filePath = String(args.path ?? "");
  const fileContent = String(args.content ?? "");
  if (!filePath) return { content: "Error: path is required", success: false };
  const check = resolveSafe(workspace, filePath);
  if ("error" in check) return { content: check.error, success: false };
  const resolved = check.resolved;
  let oldContent = null;
  try {
    const stat2 = await import_promises2.default.stat(resolved);
    if (stat2.isFile()) {
      oldContent = await import_promises2.default.readFile(resolved, "utf-8");
    }
  } catch {
  }
  const dir = import_node_path4.default.dirname(resolved);
  await import_promises2.default.mkdir(dir, { recursive: true });
  await import_promises2.default.writeFile(resolved, fileContent, "utf-8");
  const relPath = import_node_path4.default.relative(workspace, resolved);
  return {
    content: `File written: ${resolved} (${fileContent.length} chars)`,
    success: true,
    fileChange: { filePath: relPath, oldContent, newContent: fileContent }
  };
}
async function execDeleteFile(args, workspace) {
  const filePath = String(args.path ?? "");
  if (!filePath) return { content: "Error: path is required", success: false };
  const check = resolveSafe(workspace, filePath);
  if ("error" in check) return { content: check.error, success: false };
  const resolved = check.resolved;
  let oldContent = null;
  try {
    const stat2 = await import_promises2.default.stat(resolved);
    if (!stat2.isFile()) return { content: `Error: Not a file: ${resolved}`, success: false };
    oldContent = await import_promises2.default.readFile(resolved, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { content: `Error: File not found: ${resolved}`, success: false };
    }
    throw err;
  }
  await import_promises2.default.unlink(resolved);
  const relPath = import_node_path4.default.relative(workspace, resolved);
  return {
    content: `File deleted: ${resolved}`,
    success: true,
    fileChange: { filePath: relPath, oldContent, newContent: null }
  };
}
var FS_IGNORE = /* @__PURE__ */ new Set([
  ".git",
  "node_modules",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  ".cache",
  ".turbo",
  "coverage",
  "release",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".parcel-cache",
  ".DS_Store"
]);
function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
function toPosixPath(input) {
  return input.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}
function isHiddenPath(relPath) {
  return relPath.split("/").some((segment) => segment.startsWith("."));
}
function shouldSkipName(name, includeHidden) {
  if (FS_IGNORE.has(name)) return true;
  if (!includeHidden && name.startsWith(".")) return true;
  return false;
}
function addDirectoryAncestors(relPath, dirSet) {
  const parts = relPath.split("/");
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    if (dir) dirSet.add(dir);
  }
}
function buildWorkspaceEntries(fileSet, dirSet) {
  const entries = [];
  for (const dir of dirSet) {
    const clean = toPosixPath(dir);
    if (!clean) continue;
    entries.push({
      path: clean,
      name: clean.split("/").pop() || clean,
      kind: "directory",
      depth: clean.split("/").length
    });
  }
  for (const file of fileSet) {
    const clean = toPosixPath(file);
    if (!clean) continue;
    entries.push({
      path: clean,
      name: clean.split("/").pop() || clean,
      kind: "file",
      depth: clean.split("/").length
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}
async function hasDirectoryContent(dir) {
  try {
    const items = await import_promises2.default.readdir(dir);
    return items.length > 0;
  } catch {
    return false;
  }
}
async function collectWorkspaceEntries(rootDir, options = {}) {
  const maxDepth = clampNumber(options.maxDepth, 1, 24, 12);
  const maxEntries = clampNumber(options.maxEntries, 200, 1e4, 4e3);
  const includeHidden = Boolean(options.includeHidden);
  const fileSet = /* @__PURE__ */ new Set();
  const dirSet = /* @__PURE__ */ new Set();
  let truncated = false;
  try {
    await execAsync("git rev-parse --show-toplevel", { cwd: rootDir, timeout: 3e3 });
    const { stdout } = await execAsync(
      "git ls-files --cached --others --exclude-standard",
      { cwd: rootDir, timeout: 6e3, maxBuffer: 8 * 1024 * 1024 }
    );
    const files = stdout.trim().split("\n").filter(Boolean);
    if (files.length > 0 || !await hasDirectoryContent(rootDir)) {
      for (const raw of files) {
        if (fileSet.size + dirSet.size >= maxEntries) {
          truncated = true;
          break;
        }
        const relPath = toPosixPath(raw);
        if (!relPath) continue;
        if (!includeHidden && isHiddenPath(relPath)) continue;
        if (relPath.split("/").length > maxDepth + 8) {
          truncated = true;
          continue;
        }
        fileSet.add(relPath);
        addDirectoryAncestors(relPath, dirSet);
      }
      return { entries: buildWorkspaceEntries(fileSet, dirSet), truncated };
    }
  } catch {
  }
  const scanDepth = Math.min(maxDepth + 8, 24);
  async function scan(absDir, relDir, depth) {
    if (depth > scanDepth || fileSet.size + dirSet.size >= maxEntries) {
      truncated = true;
      return;
    }
    let items;
    try {
      items = await import_promises2.default.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (shouldSkipName(item.name, includeHidden)) continue;
      const relPath = toPosixPath(relDir ? `${relDir}/${item.name}` : item.name);
      if (!relPath) continue;
      if (item.isDirectory()) {
        dirSet.add(relPath);
        await scan(import_node_path4.default.join(absDir, item.name), relPath, depth + 1);
      } else if (item.isFile()) {
        fileSet.add(relPath);
        addDirectoryAncestors(relPath, dirSet);
      }
      if (fileSet.size + dirSet.size >= maxEntries) {
        truncated = true;
        break;
      }
    }
  }
  await scan(rootDir, "", 1);
  return { entries: buildWorkspaceEntries(fileSet, dirSet), truncated };
}
function buildDirectoryTree(entries, options) {
  const root = {
    name: ".",
    path: "",
    kind: "root",
    children: /* @__PURE__ */ new Map(),
    fileCount: 0,
    dirCount: 0
  };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join("/");
      const expectedKind = isLeaf ? entry.kind : "directory";
      let child = cursor.children.get(part);
      if (!child) {
        child = {
          name: part,
          path: childPath,
          kind: expectedKind,
          children: /* @__PURE__ */ new Map(),
          fileCount: 0,
          dirCount: 0
        };
        cursor.children.set(part, child);
      } else if (child.kind === "file" && expectedKind === "directory") {
        child.kind = "directory";
      }
      cursor = child;
    }
  }
  function computeStats(node) {
    if (node.kind === "file") {
      node.fileCount = 1;
      node.dirCount = 0;
      return { files: 1, dirs: 0 };
    }
    let files = 0;
    let dirs = 0;
    for (const child of node.children.values()) {
      const sub = computeStats(child);
      files += sub.files;
      dirs += sub.dirs + (child.kind === "directory" ? 1 : 0);
    }
    node.fileCount = files;
    node.dirCount = dirs;
    return { files, dirs };
  }
  computeStats(root);
  const maxLines = clampNumber(options.maxLines, 20, 1200, 500);
  const lines = [];
  let truncated = false;
  function renderChildren(node, prefix, depth) {
    const children = [...node.children.values()].sort((a, b) => {
      const aIsDir = a.kind === "directory";
      const bIsDir = b.kind === "directory";
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (let i = 0; i < children.length; i++) {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }
      const child = children[i];
      const isLast = i === children.length - 1;
      const connector = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
      const nextPrefix = prefix + (isLast ? "    " : "\u2502   ");
      if (child.kind === "file") {
        if (options.includeFiles) {
          lines.push(`${prefix}${connector}${child.name}`);
        }
        continue;
      }
      if (depth >= options.maxDepth) {
        lines.push(
          `${prefix}${connector}${child.name}/ (${child.dirCount} dirs, ${child.fileCount} files)`
        );
        continue;
      }
      lines.push(`${prefix}${connector}${child.name}/`);
      renderChildren(child, nextPrefix, depth + 1);
      if (truncated) return;
    }
  }
  renderChildren(root, "", 1);
  return {
    text: lines.join("\n"),
    stats: {
      directoryCount: root.dirCount,
      fileCount: root.fileCount,
      lineCount: lines.length
    },
    truncated
  };
}
async function getWorkspaceTree(workspace, maxDepth = 6, showFiles = true) {
  const depth = clampNumber(maxDepth, 1, 12, 6);
  const { entries, truncated: scanTruncated } = await collectWorkspaceEntries(workspace, {
    maxDepth: depth + 8,
    includeHidden: false,
    maxEntries: 5e3
  });
  const tree = buildDirectoryTree(entries, { maxDepth: depth, includeFiles: showFiles, maxLines: 600 });
  const truncationNote = scanTruncated || tree.truncated ? "\n... (truncated)" : "";
  const body = tree.text.trim() || "(empty)";
  return `./ (${tree.stats.directoryCount} dirs, ${tree.stats.fileCount} files)
${body}${truncationNote}`;
}
async function execListDirectory(args, workspace) {
  const dirPath = String(args.path ?? ".");
  const maxDepth = clampNumber(args.maxDepth, 1, 12, 4);
  const includeFiles = args.includeFiles === void 0 ? args.showFiles !== false : Boolean(args.includeFiles);
  const includeHidden = Boolean(args.includeHidden);
  const maxEntries = clampNumber(args.maxEntries, 200, 1e4, 4e3);
  const check = await resolveSmartPath(workspace, dirPath, "directory");
  if ("error" in check) return { content: check.error, success: false };
  const resolved = check.resolved;
  const correctedNote = check.corrected ? `[\u81EA\u52A8\u7EA0\u6B63\u8DEF\u5F84: "${dirPath}" \u2192 "${check.corrected.split("\n")[0]}"]
` : "";
  const relDir = import_node_path4.default.relative(workspace, resolved) || ".";
  const { entries, truncated: scanTruncated } = await collectWorkspaceEntries(resolved, {
    maxDepth: maxDepth + 8,
    includeHidden,
    maxEntries
  });
  const tree = buildDirectoryTree(entries, {
    maxDepth,
    includeFiles,
    maxLines: 500
  });
  if (entries.length === 0) {
    return {
      content: `${correctedNote}${relDir}/
Summary: 0 dirs, 0 files
(empty directory or ignored by filters)`,
      success: true
    };
  }
  const notes = [];
  if (scanTruncated) notes.push(`scan truncated at ${maxEntries} entries`);
  if (tree.truncated) notes.push("output truncated by line limit");
  const lines = [
    `${relDir}/`,
    `Summary: ${tree.stats.directoryCount} dirs, ${tree.stats.fileCount} files`,
    tree.text || "(empty)"
  ];
  if (notes.length > 0) lines.push(`Notes: ${notes.join("; ")}`);
  return { content: correctedNote + lines.join("\n"), success: true };
}
async function execRunCommand(args, workspace, signal) {
  const command = String(args.command ?? "");
  if (!command) return { content: "Error: command is required", success: false };
  let cwd = workspace;
  if (args.cwd) {
    const check = resolveSafe(workspace, String(args.cwd));
    if ("error" in check) return { content: check.error, success: false };
    cwd = check.resolved;
  }
  try {
    const { stdout } = await execAsync(command, {
      cwd,
      timeout: 3e4,
      maxBuffer: 1024 * 1024,
      signal
    });
    return { content: stdout || "(no output)", success: true };
  } catch (err) {
    if (isAbortError(err)) return { content: "\u547D\u4EE4\u6267\u884C\u5DF2\u53D6\u6D88", success: false };
    const execErr = err;
    const stderr = execErr.stderr || "";
    const stdout = execErr.stdout || "";
    return { content: `Exit with error:
${stderr || stdout || execErr.message || "Unknown error"}`, success: false };
  }
}
function chooseFindMode(pattern, requested) {
  if (requested !== "auto") return requested;
  return /[*?{]/.test(pattern) ? "glob" : "fuzzy";
}
function isSubsequence(query, text) {
  let qi = 0;
  let ti = 0;
  while (qi < query.length && ti < text.length) {
    if (query[qi] === text[ti]) qi++;
    ti++;
  }
  return qi === query.length;
}
function scoreFindMatch(entry, pattern, mode, globRe) {
  const p = pattern.toLowerCase();
  const name = entry.name.toLowerCase();
  const full = entry.path.toLowerCase();
  const hasPathSep = p.includes("/");
  if (mode === "exact") {
    if (name === p) return 1200 - entry.depth * 2;
    if (full === p) return 1160 - entry.depth * 2;
    if (full.endsWith(`/${p}`)) return 1100 - entry.depth * 2;
    return -1;
  }
  if (mode === "glob") {
    const re = globRe ?? globToRegex(pattern);
    const matched = hasPathSep ? re.test(full) : re.test(name) || re.test(full);
    if (!matched) return -1;
    const precisionBonus = full === p ? 80 : name === p ? 60 : 0;
    return 900 + precisionBonus - entry.depth * 2;
  }
  let score = -1;
  if (name === p) score = 1e3;
  else if (full === p) score = 980;
  else if (name.startsWith(p)) score = 860;
  else if (name.includes(p)) score = 760;
  else if (isSubsequence(p, name)) score = 680;
  else if (full.includes(p)) score = 620;
  else if (isSubsequence(p, full)) score = 520;
  if (score < 0) return -1;
  if (entry.kind === "directory") score += 15;
  return score - entry.depth * 2;
}
async function execFindFile(args, workspace) {
  const pattern = String(args.pattern ?? "").trim();
  if (!pattern) return { content: "Error: pattern is required", success: false };
  const directory = String(args.directory ?? ".");
  const searchType = String(args.type ?? "file");
  const mode = chooseFindMode(
    pattern,
    ["auto", "fuzzy", "glob", "exact"].includes(String(args.mode)) ? String(args.mode) : "auto"
  );
  const includeHidden = Boolean(args.includeHidden);
  const maxResults = clampNumber(args.maxResults, 1, 200, 50);
  const check = await resolveSmartPath(workspace, directory, "directory");
  if ("error" in check) return { content: check.error, success: false };
  const resolved = check.resolved;
  const correctedNote = check.corrected ? `[\u81EA\u52A8\u7EA0\u6B63\u8DEF\u5F84: "${directory}" \u2192 "${check.corrected.split("\n")[0]}"]
` : "";
  const { entries, truncated: scanTruncated } = await collectWorkspaceEntries(resolved, {
    maxDepth: 20,
    includeHidden,
    maxEntries: 1e4
  });
  let candidates = entries;
  if (searchType === "file") candidates = candidates.filter((entry) => entry.kind === "file");
  else if (searchType === "directory") candidates = candidates.filter((entry) => entry.kind === "directory");
  const globRe = mode === "glob" ? globToRegex(pattern) : void 0;
  const scored = candidates.map((entry) => ({
    entry,
    score: scoreFindMatch(entry, pattern, mode, globRe)
  })).filter((item) => item.score >= 0).sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.entry.path.length !== b.entry.path.length) return a.entry.path.length - b.entry.path.length;
    return a.entry.path.localeCompare(b.entry.path);
  });
  if (scored.length === 0) {
    const scope2 = import_node_path4.default.relative(workspace, resolved) || ".";
    return {
      content: correctedNote + `No ${searchType === "all" ? "" : `${searchType} `}matches for "${pattern}" in ${scope2}`,
      success: true
    };
  }
  const total = scored.length;
  const visible = scored.slice(0, maxResults);
  const scope = import_node_path4.default.relative(workspace, resolved) || ".";
  const lines = [
    `Scope: ${scope}`,
    `Mode: ${mode} | Type: ${searchType} | Matches: ${total}${total > visible.length ? ` (showing ${visible.length})` : ""}`,
    ...visible.map(({ entry }) => `${entry.kind === "directory" ? "[D]" : "[F]"} ${entry.path}${entry.kind === "directory" ? "/" : ""}`)
  ];
  if (scanTruncated) lines.push("Notes: scan truncated at 10000 entries");
  return { content: correctedNote + lines.join("\n"), success: true };
}
function globToRegex(glob) {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.+/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        const alts = glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$|[\]\\()]/g, "\\$&")).join("|");
        re += `(${alts})`;
        i = end + 1;
      } else {
        re += "\\{";
        i++;
      }
    } else if (".+^$|[]\\()".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp(`^${re}$`, "i");
}
var _rgAvailable = null;
async function execSearchFiles(args, workspace) {
  const pattern = String(args.pattern ?? "").trim();
  if (!pattern) return { content: "Error: pattern is required", success: false };
  const directory = String(args.directory ?? ".");
  const filePattern = args.filePattern ? String(args.filePattern) : void 0;
  const contextLines = Math.min(Number(args.contextLines) || 2, 5);
  const maxResults = Math.min(Number(args.maxResults) || 30, 80);
  const caseSensitive = Boolean(args.caseSensitive);
  const check = await resolveSmartPath(workspace, directory, "directory");
  if ("error" in check) return { content: check.error, success: false };
  const resolved = check.resolved;
  const correctedNote = check.corrected ? `[\u81EA\u52A8\u7EA0\u6B63\u8DEF\u5F84: "${directory}" \u2192 "${check.corrected.split("\n")[0]}"]
` : "";
  const safePattern = pattern.replace(/'/g, "'\\''");
  if (_rgAvailable === null) {
    _rgAvailable = await checkCommand("rg --version");
  }
  try {
    let cmd;
    const caseFlag = caseSensitive ? "-s" : "-i";
    if (_rgAvailable) {
      const globFlag = filePattern ? `--glob '${filePattern}'` : "";
      cmd = [
        "rg",
        "-n",
        "--heading",
        "--color=never",
        caseFlag,
        `-C ${contextLines}`,
        "--max-count=10",
        // 单文件最多 10 个匹配
        "--max-columns=200",
        // 截断超长行避免 token 浪费
        "--max-columns-preview",
        // 超长行显示截断预览
        globFlag,
        `-- '${safePattern}' '${resolved}'`,
        "2>/dev/null",
        `| head -${Math.min(maxResults * 8, 400)}`
        // 按结果数动态限制总行数
      ].filter(Boolean).join(" ");
    } else {
      const defaultIncludes = [
        "*.ts",
        "*.tsx",
        "*.js",
        "*.jsx",
        "*.json",
        "*.css",
        "*.html",
        "*.md",
        "*.py",
        "*.go",
        "*.rs",
        "*.vue",
        "*.svelte"
      ];
      const includeFlags = filePattern ? `--include='${filePattern}'` : defaultIncludes.map((g) => `--include='${g}'`).join(" ");
      cmd = `grep -rn ${caseFlag} -C ${contextLines} ${includeFlags} '${safePattern}' '${resolved}' 2>/dev/null | head -200`;
    }
    const { stdout } = await execAsync(cmd, {
      cwd: workspace,
      timeout: 15e3,
      maxBuffer: 1024 * 1024
    });
    if (!stdout.trim()) {
      return { content: correctedNote + `No matches found for "${pattern}"`, success: true };
    }
    const output = stdout.split("\n").map((line) => {
      if (line.startsWith(resolved)) return line.slice(resolved.length + 1);
      if (line.startsWith(workspace)) return line.slice(workspace.length + 1);
      return line;
    }).join("\n");
    const fileSet = /* @__PURE__ */ new Set();
    for (const line of output.split("\n")) {
      const m = line.match(/^([^:]+):\d+[:-]/);
      if (m) fileSet.add(m[1]);
    }
    const header = `Found matches in ${fileSet.size || "?"} file(s):
`;
    return { content: correctedNote + header + output, success: true };
  } catch {
    return { content: correctedNote + `No matches found for "${pattern}"`, success: true };
  }
}
async function checkCommand(cmd) {
  try {
    await execAsync(cmd, { cwd: "/tmp", timeout: 5e3 });
    return true;
  } catch {
    return false;
  }
}
async function execSaveNote(args, workspace, projectId) {
  const title = String(args.title ?? "").trim();
  const content = String(args.content ?? "").trim();
  const category = String(args.category ?? "other");
  if (!title) return { content: "Error: title is required", success: false };
  if (!content) return { content: "Error: content is required", success: false };
  const { saveNote: saveNote2 } = await Promise.resolve().then(() => (init_notes(), notes_exports));
  const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const saved = await saveNote2(workspace, {
    id,
    title,
    content,
    category,
    createdAt: now,
    updatedAt: now
  }, projectId);
  return { content: `\u9879\u76EE\u7B14\u8BB0\u5DF2\u4FDD\u5B58\uFF1A\u300C${saved.title}\u300D(${saved.id})`, success: true };
}
async function execDeleteNote(args, workspace, projectId) {
  const noteId = String(args.noteId ?? "").trim();
  if (!noteId) return { content: "Error: noteId is required", success: false };
  const { deleteNote: deleteNote2 } = await Promise.resolve().then(() => (init_notes(), notes_exports));
  await deleteNote2(workspace, noteId, projectId);
  return { content: `\u9879\u76EE\u7B14\u8BB0\u5DF2\u5220\u9664\uFF1A${noteId}`, success: true };
}
async function execBrowserAction(action, args) {
  const appId = args.appId ? String(args.appId) : void 0;
  log(`Browser action: ${action} [appId=${appId || "default"}]`, args);
  const result = await executeBrowserAction({ action, params: args }, appId);
  if (result.success) {
    if (action === "screenshot" && result.data) {
      try {
        const parsed = JSON.parse(result.data);
        const pageInfo = parsed.page ?? {};
        const screenshotDataUrl = parsed.screenshot || parsed.dataUrl;
        let screenshotPath = "";
        if (screenshotDataUrl) {
          try {
            screenshotPath = await saveScreenshot(screenshotDataUrl, appId || "default");
          } catch (err) {
            log("SCREENSHOT_SAVE_FAIL", { error: err instanceof Error ? err.message : String(err) });
          }
        }
        return {
          content: JSON.stringify({
            screenshotPath: screenshotPath || void 0,
            title: pageInfo.title,
            url: pageInfo.url,
            viewport: pageInfo.viewport,
            visibleElements: pageInfo.elements ?? [],
            hint: screenshotPath ? "\u622A\u56FE\u5DF2\u4FDD\u5B58\u5230\u672C\u5730\u3002\u5982\u9700\u8C03\u7528 MiniMax MCP \u5206\u6790\u56FE\u7247\uFF0C\u8BF7\u5148\u7528 mcp_list_tools \u786E\u8BA4 understand_image \u7684\u53C2\u6570\u5B9A\u4E49\uFF0C\u518D\u7528 mcp_call \u4F20\u5165 screenshotPath\u3002" : void 0
          }, null, 2),
          success: true
        };
      } catch {
        return { content: result.data ?? "\u622A\u56FE\u6210\u529F", success: true };
      }
    }
    return { content: result.data ?? "\u64CD\u4F5C\u6210\u529F", success: true };
  }
  return { content: `\u6D4F\u89C8\u5668\u64CD\u4F5C\u5931\u8D25: ${result.error}`, success: false };
}
async function execMcpCall(args, signal) {
  const serverId = String(args.server_id ?? "").trim();
  const toolName = String(args.tool_name ?? "").trim();
  const toolArgs = args.arguments ?? {};
  if (!serverId) return { content: "Error: server_id is required", success: false };
  if (!toolName) return { content: "Error: tool_name is required", success: false };
  if (signal?.aborted) throw makeAbortError();
  try {
    const result = await callMcpTool(serverId, toolName, toolArgs);
    const texts = [];
    for (const item of result.content ?? []) {
      if (item.type === "text" && item.text) {
        texts.push(item.text);
      } else if (item.type === "image" && item.data) {
        try {
          const imgPath = await saveScreenshot(`data:image/png;base64,${item.data}`);
          texts.push(`[\u56FE\u7247\u5DF2\u4FDD\u5B58: ${imgPath}]`);
        } catch {
          texts.push("[\u56FE\u7247\u6570\u636E\u63A5\u6536\u6210\u529F\u4F46\u4FDD\u5B58\u5931\u8D25]");
        }
      } else if (item.type === "resource") {
        texts.push(`[Resource: ${JSON.stringify(item)}]`);
      }
    }
    const content = texts.join("\n") || "(MCP \u5DE5\u5177\u8FD4\u56DE\u7A7A\u7ED3\u679C)";
    return { content, success: !result.isError };
  } catch (err) {
    return { content: `MCP \u8C03\u7528\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`, success: false };
  }
}
async function execMcpListTools() {
  const mcpTools = getActiveMcpTools();
  if (mcpTools.length === 0) {
    return {
      content: "\u5F53\u524D\u6CA1\u6709\u5DF2\u542F\u7528\u7684 MCP \u670D\u52A1\u5668\u6216\u6CA1\u6709\u53EF\u7528\u5DE5\u5177\u3002\u8BF7\u5728\u8BBE\u7F6E\u4E2D\u542F\u7528 MCP \u670D\u52A1\u5668\u5E76\u914D\u7F6E API Key\u3002",
      success: true
    };
  }
  const groups = {};
  for (const tool of mcpTools) {
    if (!groups[tool.serverId]) groups[tool.serverId] = [];
    groups[tool.serverId].push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
  }
  const lines = ["\u5DF2\u542F\u7528\u7684 MCP \u5DE5\u5177\u5217\u8868\uFF1A", ""];
  for (const [serverId, tools] of Object.entries(groups)) {
    lines.push(`## \u670D\u52A1\u5668: ${serverId}`);
    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description ?? "(\u65E0\u63CF\u8FF0)"}`);
      if (tool.inputSchema?.properties) {
        const props = tool.inputSchema.properties;
        const required = tool.inputSchema.required ?? [];
        for (const [key, val] of Object.entries(props)) {
          const req = required.includes(key) ? " (\u5FC5\u9700)" : " (\u53EF\u9009)";
          lines.push(`  - \`${key}\` (${val.type ?? "any"}${req}): ${val.description ?? ""}`);
        }
      }
    }
    lines.push("");
  }
  lines.push("\u4F7F\u7528 mcp_call \u5DE5\u5177\u6765\u8C03\u7528\u4E0A\u8FF0\u5DE5\u5177\uFF0C\u4F20\u5165 server_id\u3001tool_name \u548C arguments\u3002");
  return { content: lines.join("\n"), success: true };
}
var DANGER_PATTERNS = [
  // 包安装
  [/\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b/i, "\u5B89\u88C5 npm \u5305", "package_install"],
  [/\bpip3?\s+install\b/i, "\u5B89\u88C5 Python \u5305", "package_install"],
  [/\b(brew|apt|apt-get|yum|dnf|pacman|apk)\s+install\b/i, "\u5B89\u88C5\u7CFB\u7EDF\u8F6F\u4EF6", "package_install"],
  [/\bcargo\s+(install|add)\b/i, "\u5B89\u88C5 Rust \u5305", "package_install"],
  [/\bgo\s+(install|get)\b/i, "\u5B89\u88C5 Go \u5305", "package_install"],
  [/\bgem\s+install\b/i, "\u5B89\u88C5 Ruby Gem", "package_install"],
  // 权限提升
  [/\bsudo\b/i, "\u4F7F\u7528 sudo \u63D0\u6743", "privilege_cmd"],
  [/\bsu\s/i, "\u5207\u6362\u7528\u6237", "privilege_cmd"],
  // 破坏性操作
  [/\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f|--recursive|--force)/i, "\u9012\u5F52/\u5F3A\u5236\u5220\u9664\u6587\u4EF6", "destructive_cmd"],
  [/\brm\s+-rf\b/i, "\u9012\u5F52\u5F3A\u5236\u5220\u9664", "destructive_cmd"],
  [/\brmdir\b/i, "\u5220\u9664\u76EE\u5F55", "destructive_cmd"],
  // 系统修改
  [/\bchmod\b/i, "\u4FEE\u6539\u6587\u4EF6\u6743\u9650", "system_modify"],
  [/\bchown\b/i, "\u4FEE\u6539\u6587\u4EF6\u6240\u6709\u8005", "system_modify"],
  [/\bmkfs\b/i, "\u683C\u5F0F\u5316\u78C1\u76D8", "system_modify"],
  [/\bdd\s+if=/i, "\u78C1\u76D8\u7EA7\u5199\u5165", "system_modify"],
  // Git 危险操作
  [/\bgit\s+(push\s+(-[a-zA-Z]*f|--force)|reset\s+--hard)/i, "Git \u5F3A\u5236\u64CD\u4F5C", "git_force"],
  // 网络相关
  [/\bcurl\b.*\|\s*(sh|bash)\b/i, "\u4E0B\u8F7D\u5E76\u6267\u884C\u811A\u672C", "network_script"],
  [/\bwget\b.*\|\s*(sh|bash)\b/i, "\u4E0B\u8F7D\u5E76\u6267\u884C\u811A\u672C", "network_script"]
];
var WARNING_PATTERNS = [
  [/\bgit\s+push\b/i, "Git push", "git_ops"],
  [/\bgit\s+checkout\s+(-b|--orphan)/i, "Git \u521B\u5EFA\u5206\u652F", "git_ops"],
  [/\bgit\s+merge\b/i, "Git merge", "git_ops"],
  [/\bgit\s+rebase\b/i, "Git rebase", "git_ops"],
  [/\bdocker\s+(run|build|pull|push)\b/i, "Docker \u64CD\u4F5C", "docker_ops"]
];
var BROWSER_TOOL_PREFIX = "browser_";
var browserAutoApproved = false;
function setBrowserAutoApproved(approved) {
  browserAutoApproved = approved;
}
var autoApproveCategories = /* @__PURE__ */ new Set();
function setAutoApproveCategories(categories) {
  autoApproveCategories.clear();
  for (const cat of categories) autoApproveCategories.add(cat);
  if (autoApproveCategories.has("browser_ops")) {
    browserAutoApproved = true;
  }
}
function assessToolCallsRisk(toolCalls) {
  const risks = [];
  for (const tc of toolCalls) {
    let args = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      continue;
    }
    const toolName = tc.function.name;
    if (toolName.startsWith(BROWSER_TOOL_PREFIX) && !browserAutoApproved && !autoApproveCategories.has("browser_ops")) {
      const url = String(args.url ?? args.selector ?? args.expression ?? "");
      risks.push({
        toolCallId: tc.id,
        toolName,
        level: "warning",
        reason: `\u6D4F\u89C8\u5668\u64CD\u4F5C: ${toolName.replace(BROWSER_TOOL_PREFIX, "")}`,
        detail: url || "(\u65E0\u53C2\u6570)"
      });
      continue;
    }
    if (toolName === "run_command") {
      const command = String(args.command ?? "");
      if (!command) continue;
      for (const [pattern, reason, category] of DANGER_PATTERNS) {
        if (pattern.test(command)) {
          if (autoApproveCategories.has(category)) break;
          risks.push({
            toolCallId: tc.id,
            toolName,
            level: "danger",
            reason,
            detail: command
          });
          break;
        }
      }
      if (!risks.some((r) => r.toolCallId === tc.id)) {
        for (const [pattern, reason, category] of WARNING_PATTERNS) {
          if (pattern.test(command)) {
            if (autoApproveCategories.has(category)) break;
            risks.push({
              toolCallId: tc.id,
              toolName,
              level: "warning",
              reason,
              detail: command
            });
            break;
          }
        }
      }
    }
  }
  return risks;
}
async function executeToolCalls(toolCalls, workspace, signal, logScope, projectId) {
  const results = [];
  for (const tc of toolCalls) {
    if (signal?.aborted) break;
    let args = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      results.push({
        tool_call_id: tc.id,
        name: tc.function.name,
        content: `Error: Invalid JSON arguments: ${tc.function.arguments}`,
        success: false
      });
      continue;
    }
    log("TOOL_CALL", { id: tc.id, name: tc.function.name, arguments: args, workspace }, logScope);
    let result;
    try {
      result = await executeTool(tc.function.name, args, workspace, signal, projectId);
    } catch (err) {
      if (isAbortError(err)) break;
      const msg = err instanceof Error ? err.message : String(err);
      result = { content: `Error: ${msg}`, success: false };
    }
    log("TOOL_RESULT", { id: tc.id, name: tc.function.name, success: result.success, content: result.content }, logScope);
    results.push({
      tool_call_id: tc.id,
      name: tc.function.name,
      ...result
    });
  }
  return results;
}

// src/main/llm.ts
var providerConfigs = {
  deepseek: {
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat"
  },
  kimi: {
    baseUrl: process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1",
    apiKey: process.env.KIMI_API_KEY ?? "",
    model: process.env.KIMI_MODEL ?? "kimi-k2.5"
  },
  minimax: {
    baseUrl: process.env.MINIMAX_BASE_URL ?? "https://api.minimaxi.com/v1",
    apiKey: process.env.MINIMAX_API_KEY ?? "",
    model: process.env.MINIMAX_MODEL ?? "MiniMax-M2.1"
  },
  glm: {
    baseUrl: process.env.GLM_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
    apiKey: process.env.GLM_API_KEY ?? "",
    model: process.env.GLM_MODEL ?? "glm-4.7"
  }
};
function getProviderConfig(provider, overrides) {
  const base = providerConfigs[provider];
  const patch = overrides?.[provider];
  return {
    ...base,
    ...patch ?? {},
    headers: {
      ...base.headers ?? {},
      ...patch?.headers ?? {}
    }
  };
}
function buildRequest(config, messages, stream, options) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`
  };
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      if (typeof v === "string") headers[k] = v;
    }
  }
  const body = {
    model: config.model,
    messages,
    temperature: 0.1,
    stream
  };
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = "auto";
  }
  return {
    url: `${config.baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    }
  };
}
async function requestChatCompletion(provider, messages, overrides, signal, logScope) {
  const config = getProviderConfig(provider, overrides);
  if (!config.apiKey || !config.model) {
    throw new Error(`Missing API key or model for ${provider}`);
  }
  const { url, init } = buildRequest(config, messages, false);
  const startTime = Date.now();
  log("REQUEST", { url, method: init.method, headers: init.headers, body: init.body }, logScope);
  let response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (err) {
    log("ERROR", { url, error: String(err), durationMs: Date.now() - startTime }, logScope);
    throw err;
  }
  const rawText = await response.text();
  log("RESPONSE", {
    url,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    durationMs: Date.now() - startTime,
    body: rawText
  }, logScope);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} ${rawText}`);
  }
  const data = JSON.parse(rawText);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from provider");
  }
  return content;
}
async function* requestChatCompletionStream(provider, messages, overrides, signal, logScope) {
  const config = getProviderConfig(provider, overrides);
  if (!config.apiKey || !config.model) {
    throw new Error(`Missing API key or model for ${provider}`);
  }
  const { url, init } = buildRequest(config, messages, true);
  const startTime = Date.now();
  log("REQUEST", { url, method: init.method, headers: init.headers, body: init.body }, logScope);
  let response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (err) {
    log("ERROR", { url, error: String(err), durationMs: Date.now() - startTime }, logScope);
    throw err;
  }
  if (!response.ok) {
    const text = await response.text();
    log("RESPONSE", {
      url,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      durationMs: Date.now() - startTime,
      body: text
    }, logScope);
    throw new Error(`Request failed: ${response.status} ${response.statusText} ${text}`);
  }
  if (!response.body) {
    throw new Error("Response body is empty (streaming not supported?)");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let firstChunk = null;
  let lastChunk = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          logMergedStreamResponse(url, response.status, Date.now() - startTime, firstChunk, lastChunk, accumulated, logScope);
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (!firstChunk) firstChunk = parsed;
          lastChunk = parsed;
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            accumulated += content;
            yield content;
          }
        } catch {
        }
      }
    }
    logMergedStreamResponse(url, response.status, Date.now() - startTime, firstChunk, lastChunk, accumulated, logScope);
  } catch (err) {
    log("RESPONSE_ERROR", {
      url,
      status: response.status,
      durationMs: Date.now() - startTime,
      body: buildMergedResponse(firstChunk, lastChunk, accumulated),
      error: String(err)
    }, logScope);
    throw err;
  }
}
function buildMergedResponse(firstChunk, lastChunk, content) {
  if (!firstChunk) return { content };
  return {
    id: firstChunk.id,
    object: "chat.completion",
    model: firstChunk.model,
    created: firstChunk.created,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: lastChunk?.choices?.[0]?.finish_reason ?? "stop"
      }
    ],
    usage: lastChunk?.usage ?? null
  };
}
function logMergedStreamResponse(url, status, durationMs, firstChunk, lastChunk, content, logScope) {
  log("RESPONSE", {
    url,
    status,
    durationMs,
    body: buildMergedResponse(firstChunk, lastChunk, content)
  }, logScope);
}
async function* requestStreamWithTools(provider, messages, overrides, options, signal, logScope) {
  const config = getProviderConfig(provider, overrides);
  if (!config.apiKey || !config.model) {
    throw new Error(`Missing API key or model for ${provider}`);
  }
  const { url, init } = buildRequest(config, messages, true, options);
  const startTime = Date.now();
  log("REQUEST", { url, method: init.method, headers: init.headers, body: init.body }, logScope);
  let response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (err) {
    log("ERROR", { url, error: String(err), durationMs: Date.now() - startTime }, logScope);
    throw err;
  }
  if (!response.ok) {
    const text = await response.text();
    log("RESPONSE", { url, status: response.status, durationMs: Date.now() - startTime, body: text }, logScope);
    throw new Error(`Request failed: ${response.status} ${response.statusText} ${text}`);
  }
  if (!response.body) {
    throw new Error("Response body is empty");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  const toolCallsMap = /* @__PURE__ */ new Map();
  let firstChunk = null;
  let lastChunk = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          if (toolCallsMap.size > 0) {
            const toolCalls = Array.from(toolCallsMap.values());
            yield { type: "tool_calls", toolCalls };
          }
          logMergedStreamResponse(url, response.status, Date.now() - startTime, firstChunk, lastChunk, accumulated, logScope);
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (!firstChunk) firstChunk = parsed;
          lastChunk = parsed;
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            accumulated += delta.content;
            yield { type: "text", content: delta.content };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCallsMap.get(idx);
              if (!existing) {
                toolCallsMap.set(idx, {
                  id: tc.id ?? "",
                  type: "function",
                  function: {
                    name: tc.function?.name ?? "",
                    arguments: tc.function?.arguments ?? ""
                  }
                });
              } else {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.function.name += tc.function.name;
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
              }
            }
          }
        } catch {
        }
      }
    }
    if (toolCallsMap.size > 0) {
      const toolCalls = Array.from(toolCallsMap.values());
      yield { type: "tool_calls", toolCalls };
    }
    logMergedStreamResponse(url, response.status, Date.now() - startTime, firstChunk, lastChunk, accumulated, logScope);
  } catch (err) {
    log("RESPONSE_ERROR", { url, status: response.status, durationMs: Date.now() - startTime, error: String(err) }, logScope);
    throw err;
  }
}

// src/main/git.ts
var import_node_child_process4 = require("node:child_process");
function git(cwd, args) {
  return new Promise((resolve2, reject) => {
    (0, import_node_child_process4.exec)(`git ${args}`, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve2(stdout.trim());
      }
    });
  });
}
async function isGitRepo(cwd) {
  try {
    await git(cwd, "rev-parse --is-inside-work-tree");
    return true;
  } catch {
    return false;
  }
}
async function gitEnsureRepo(cwd) {
  if (await isGitRepo(cwd)) return;
  await git(cwd, "init");
  await git(cwd, 'config user.name "Taco"');
  await git(cwd, 'config user.email "taco@local"');
  await git(cwd, "add -A");
  try {
    await git(cwd, 'commit -m "[taco] \u521D\u59CB\u7248\u672C" --allow-empty');
  } catch {
  }
}
async function gitCommit(cwd, message) {
  await gitEnsureRepo(cwd);
  await git(cwd, "add -A");
  try {
    await git(cwd, "diff --cached --quiet");
    return null;
  } catch {
  }
  const safeMsg = message.replace(/"/g, '\\"');
  await git(cwd, `commit -m "[taco] ${safeMsg}"`);
  const hash = await git(cwd, "rev-parse HEAD");
  return hash;
}
async function gitLog(cwd, maxCount = 50) {
  if (!await isGitRepo(cwd)) return [];
  try {
    const raw = await git(
      cwd,
      `log --grep="\\[taco\\]" --format="%H|%h|%at|%s" -n ${maxCount}`
    );
    if (!raw) return [];
    const commits = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const [hash, shortHash, ts, ...msgParts] = line.split("|");
      const message = msgParts.join("|");
      commits.push({
        hash,
        shortHash,
        message: message.replace(/^\[taco\]\s*/, ""),
        // 去掉 [taco] 前缀
        timestamp: Number(ts),
        fileCount: 0
        // 下面填充
      });
    }
    for (const commit of commits) {
      try {
        const stat2 = await git(cwd, `diff-tree --no-commit-id --name-only -r ${commit.hash}`);
        commit.fileCount = stat2 ? stat2.split("\n").filter(Boolean).length : 0;
      } catch {
      }
    }
    return commits;
  } catch {
    return [];
  }
}
async function gitCommitFiles(cwd, hash) {
  try {
    const raw = await git(cwd, `diff-tree --no-commit-id --name-only -r ${hash}`);
    return raw ? raw.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}
async function gitRollback(cwd, hash) {
  await git(cwd, `reset --hard ${hash}`);
}

// src/main/skills.ts
var fs5 = __toESM(require("node:fs/promises"), 1);
var path6 = __toESM(require("node:path"), 1);
var import_electron4 = require("electron");
var TACO_DIR2 = path6.join(import_electron4.app.getPath("home"), ".taco");
var SKILLS_DIR = path6.join(TACO_DIR2, "skills");
var SKILLS_JSON = path6.join(TACO_DIR2, "skills.json");
var BUILTIN_SKILLS = [
  {
    id: "code-review",
    name: "\u4EE3\u7801\u5BA1\u67E5",
    description: "\u5728\u4FEE\u6539\u4EE3\u7801\u540E\u81EA\u52A8\u68C0\u67E5\u6F5C\u5728\u95EE\u9898\uFF0C\u63D0\u4F9B\u4EE3\u7801\u5BA1\u67E5\u5EFA\u8BAE",
    version: "1.0.0",
    author: "Taco",
    source: "builtin",
    enabled: true,
    instructions: `# Skill: \u4EE3\u7801\u5BA1\u67E5
\u5F53\u4F60\u4FEE\u6539\u4E86\u4EE3\u7801\u6587\u4EF6\u540E\uFF0C\u4E3B\u52A8\u5BF9\u6539\u52A8\u8FDB\u884C\u7B80\u8981\u7684\u4EE3\u7801\u5BA1\u67E5\uFF1A
- \u68C0\u67E5\u662F\u5426\u6709\u660E\u663E\u7684 bug \u6216\u903B\u8F91\u9519\u8BEF
- \u68C0\u67E5\u662F\u5426\u6709\u672A\u5904\u7406\u7684\u8FB9\u754C\u60C5\u51B5
- \u68C0\u67E5\u662F\u5426\u6709\u5B89\u5168\u9690\u60A3\uFF08\u5982 SQL \u6CE8\u5165\u3001XSS \u7B49\uFF09
- \u68C0\u67E5\u4EE3\u7801\u98CE\u683C\u662F\u5426\u4E0E\u9879\u76EE\u4E00\u81F4
\u5982\u679C\u53D1\u73B0\u95EE\u9898\uFF0C\u5728\u6700\u7EC8\u56DE\u590D\u4E2D\u7B80\u8981\u8BF4\u660E\u3002\u4E0D\u9700\u8981\u5BF9\u6BCF\u6B21\u4FEE\u6539\u90FD\u957F\u7BC7\u5927\u8BBA\uFF0C\u53EA\u5728\u53D1\u73B0\u660E\u663E\u95EE\u9898\u65F6\u63D0\u9192\u3002`
  },
  {
    id: "auto-test",
    name: "\u81EA\u52A8\u6D4B\u8BD5",
    description: "\u4FEE\u6539\u4EE3\u7801\u540E\u81EA\u52A8\u8FD0\u884C\u76F8\u5173\u6D4B\u8BD5\u5E76\u62A5\u544A\u7ED3\u679C",
    version: "1.0.0",
    author: "Taco",
    source: "builtin",
    enabled: false,
    instructions: `# Skill: \u81EA\u52A8\u6D4B\u8BD5
\u5F53\u4F60\u4FEE\u6539\u4E86\u4EE3\u7801\u6587\u4EF6\u540E\uFF0C\u68C0\u67E5\u9879\u76EE\u4E2D\u662F\u5426\u6709\u5BF9\u5E94\u7684\u6D4B\u8BD5\u6587\u4EF6\uFF1A
- \u5982\u679C\u6709\uFF0C\u5728\u4FEE\u6539\u5B8C\u6210\u540E\u7528 run_command \u6267\u884C\u76F8\u5173\u6D4B\u8BD5
- \u5982\u679C\u6D4B\u8BD5\u5931\u8D25\uFF0C\u5206\u6790\u5931\u8D25\u539F\u56E0\u5E76\u5C1D\u8BD5\u4FEE\u590D
- \u5728\u6700\u7EC8\u56DE\u590D\u4E2D\u62A5\u544A\u6D4B\u8BD5\u6267\u884C\u7ED3\u679C
\u5E38\u89C1\u6D4B\u8BD5\u6846\u67B6\u68C0\u6D4B\uFF1A
- Node.js: \u68C0\u67E5 package.json \u4E2D\u7684 test script\uFF0C\u4F7F\u7528 npm test / jest / vitest
- Python: \u68C0\u67E5 pytest / unittest
- Go: go test
- Rust: cargo test`
  },
  {
    id: "git-best-practice",
    name: "Git \u6700\u4F73\u5B9E\u8DF5",
    description: "\u9075\u5FAA Git \u6700\u4F73\u5B9E\u8DF5\uFF0C\u81EA\u52A8\u751F\u6210\u89C4\u8303\u7684 commit message",
    version: "1.0.0",
    author: "Taco",
    source: "builtin",
    enabled: false,
    instructions: `# Skill: Git \u6700\u4F73\u5B9E\u8DF5
\u5728\u6267\u884C Git \u64CD\u4F5C\u65F6\u9075\u5FAA\u4EE5\u4E0B\u89C4\u8303\uFF1A
- Commit message \u4F7F\u7528 Conventional Commits \u683C\u5F0F\uFF1Atype(scope): description
  - feat: \u65B0\u529F\u80FD
  - fix: Bug \u4FEE\u590D
  - refactor: \u91CD\u6784
  - docs: \u6587\u6863
  - style: \u4EE3\u7801\u683C\u5F0F
  - test: \u6D4B\u8BD5
  - chore: \u6784\u5EFA/\u5DE5\u5177
- \u6BCF\u6B21\u4FEE\u6539\u5C3D\u91CF\u4FDD\u6301\u539F\u5B50\u6027\uFF0C\u4E00\u4E2A commit \u53EA\u505A\u4E00\u4EF6\u4E8B
  - \u5728\u6267\u884C git push \u524D\u63D0\u9192\u7528\u6237\u786E\u8BA4`
  },
  {
    id: "browser-automation",
    name: "\u6D4F\u89C8\u5668\u81EA\u52A8\u5316",
    description: "\u64CD\u63A7\u5185\u5D4C\u6D4F\u89C8\u5668\u6267\u884C\u81EA\u52A8\u5316\u64CD\u4F5C\uFF1A\u9875\u9762\u5BFC\u822A\u3001\u5143\u7D20\u70B9\u51FB\u3001\u8868\u5355\u586B\u5199\u3001\u5185\u5BB9\u63D0\u53D6\u3001UI \u9A8C\u8BC1\u7B49",
    version: "1.0.0",
    author: "Taco",
    source: "builtin",
    enabled: true,
    instructions: `# Skill: \u6D4F\u89C8\u5668\u81EA\u52A8\u5316

\u4F60\u53EF\u4EE5\u901A\u8FC7\u6D4F\u89C8\u5668\u81EA\u52A8\u5316\u5DE5\u5177\u64CD\u63A7\u5185\u5D4C\u6D4F\u89C8\u5668\uFF0C\u6267\u884C\u4EE5\u4E0B\u7C7B\u578B\u7684\u4EFB\u52A1\uFF1A

## \u9002\u7528\u573A\u666F
- **\u524D\u7AEF\u5F00\u53D1\u9A8C\u8BC1**: \u6253\u5F00\u672C\u5730\u5F00\u53D1\u670D\u52A1\u5668\uFF08\u5982 http://localhost:3000\uFF09\uFF0C\u9A8C\u8BC1 UI \u663E\u793A\u6548\u679C
- **\u81EA\u52A8\u5316\u6D4B\u8BD5**: \u6A21\u62DF\u7528\u6237\u64CD\u4F5C\u6D41\u7A0B\uFF08\u767B\u5F55\u3001\u586B\u5199\u8868\u5355\u3001\u70B9\u51FB\u6309\u94AE\uFF09\uFF0C\u9A8C\u8BC1\u529F\u80FD\u6B63\u786E\u6027
- **\u7F51\u9875\u6570\u636E\u63D0\u53D6**: \u6253\u5F00\u7F51\u9875\uFF0C\u63D0\u53D6\u9875\u9762\u5185\u5BB9\u548C\u6570\u636E
- **UI \u95EE\u9898\u6392\u67E5**: \u622A\u56FE\u5206\u6790\u9875\u9762\u5E03\u5C40\u3001\u6837\u5F0F\u95EE\u9898

## \u64CD\u4F5C\u6D41\u7A0B\u6A21\u5F0F
\u5178\u578B\u7684\u6D4F\u89C8\u5668\u64CD\u4F5C\u5E94\u9075\u5FAA"\u89C2\u5BDF-\u64CD\u4F5C-\u9A8C\u8BC1"\u7684\u5FAA\u73AF\uFF1A

1. **browser_navigate** \u2192 \u6253\u5F00\u76EE\u6807\u9875\u9762
2. **browser_screenshot** \u2192 \u89C2\u5BDF\u5F53\u524D\u9875\u9762\u72B6\u6001\uFF0C\u4E86\u89E3\u53EF\u7528\u7684\u4EA4\u4E92\u5143\u7D20
3. **browser_click / browser_type** \u2192 \u6267\u884C\u5177\u4F53\u64CD\u4F5C
4. **browser_screenshot** \u2192 \u9A8C\u8BC1\u64CD\u4F5C\u7ED3\u679C
5. \u91CD\u590D\u6B65\u9AA4 3-4 \u76F4\u5230\u5B8C\u6210

## \u5173\u952E\u6CE8\u610F\u4E8B\u9879
- \u6BCF\u6B21\u64CD\u4F5C\u4E4B\u524D\u90FD\u5E94\u5148 screenshot \u4E86\u89E3\u9875\u9762\u72B6\u6001
- CSS \u9009\u62E9\u5668\u5E94\u5C3D\u91CF\u4F7F\u7528\u7A33\u5B9A\u7684\u6807\u8BC6\uFF08id\u3001name\u3001data-testid\uFF09
- \u9875\u9762\u8DF3\u8F6C\u6216\u5F02\u6B65\u52A0\u8F7D\u540E\u4F7F\u7528 browser_wait \u7B49\u5F85\u5173\u952E\u5143\u7D20
- \u9047\u5230\u9519\u8BEF\u65F6\u5148\u622A\u56FE\u5206\u6790\u518D\u91CD\u8BD5\uFF0C\u4E0D\u8981\u76F2\u76EE\u91CD\u590D\u64CD\u4F5C
- \u8868\u5355\u586B\u5199\u65F6\u6CE8\u610F\u4F7F\u7528 clear: true \u6E05\u7A7A\u540E\u518D\u8F93\u5165
- \u5BF9\u4E8E\u9700\u8981\u767B\u5F55\u7684\u9875\u9762\uFF0C\u5148\u5B8C\u6210\u767B\u5F55\u6D41\u7A0B\u518D\u8FDB\u884C\u540E\u7EED\u64CD\u4F5C`
  }
];
async function ensureDirs2() {
  await fs5.mkdir(SKILLS_DIR, { recursive: true });
}
async function loadPersistedSkills() {
  try {
    const data = await fs5.readFile(SKILLS_JSON, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}
async function savePersistedSkills(skills) {
  await ensureDirs2();
  await fs5.writeFile(SKILLS_JSON, JSON.stringify(skills, null, 2), "utf-8");
}
async function loadSkillInstructions(skillId) {
  const filePath = path6.join(SKILLS_DIR, skillId, "SKILL.md");
  try {
    return await fs5.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}
async function saveSkillInstructions(skillId, content) {
  const dir = path6.join(SKILLS_DIR, skillId);
  await fs5.mkdir(dir, { recursive: true });
  await fs5.writeFile(path6.join(dir, "SKILL.md"), content, "utf-8");
}
var allSkills = [];
async function initSkills() {
  await ensureDirs2();
  const persisted = await loadPersistedSkills();
  const result = BUILTIN_SKILLS.map((builtin) => {
    const saved = persisted.find((p) => p.id === builtin.id);
    return { ...builtin, enabled: saved ? saved.enabled : builtin.enabled };
  });
  for (const p of persisted) {
    if (p.source === "builtin") continue;
    const instructions = await loadSkillInstructions(p.id);
    result.push({ ...p, instructions });
  }
  allSkills = result;
}
function listSkills() {
  return allSkills.map((s) => ({ ...s }));
}
function getActiveSkillInstructions() {
  return allSkills.filter((s) => s.enabled && s.instructions.trim()).map((s) => s.instructions);
}
async function toggleSkill(id, enabled) {
  const skill = allSkills.find((s) => s.id === id);
  if (!skill) throw new Error(`Skill not found: ${id}`);
  skill.enabled = enabled;
  await persistAll();
}
async function uninstallSkill(id) {
  const idx = allSkills.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`Skill not found: ${id}`);
  if (allSkills[idx].source === "builtin") throw new Error("Cannot uninstall builtin skill");
  allSkills.splice(idx, 1);
  const dir = path6.join(SKILLS_DIR, id);
  try {
    await fs5.rm(dir, { recursive: true });
  } catch {
  }
  await persistAll();
}
async function installSkill(source) {
  let instructions;
  let meta = {};
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const rawUrl = toRawGitHubUrl(source);
    const resp = await fetch(rawUrl);
    if (!resp.ok) throw new Error(`Failed to fetch skill: ${resp.status} ${resp.statusText}`);
    instructions = await resp.text();
    meta = parseSkillMeta(instructions);
  } else {
    const filePath = source.endsWith("SKILL.md") ? source : path6.join(source, "SKILL.md");
    try {
      instructions = await fs5.readFile(filePath, "utf-8");
      meta = parseSkillMeta(instructions);
    } catch {
      throw new Error(`Cannot read skill file: ${filePath}`);
    }
  }
  const id = meta.name ? meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : `skill-${Date.now()}`;
  if (allSkills.some((s) => s.id === id)) {
    const existing = allSkills.find((s) => s.id === id);
    existing.instructions = instructions;
    existing.version = meta.version || existing.version;
    existing.description = meta.description || existing.description;
    await saveSkillInstructions(id, instructions);
    await persistAll();
    return { ...existing };
  }
  const skill = {
    id,
    name: meta.name || id,
    description: meta.description || "",
    version: meta.version || "1.0.0",
    author: meta.author || "Unknown",
    source: source.startsWith("http") ? "remote" : "local",
    sourceUrl: source.startsWith("http") ? source : void 0,
    enabled: true,
    instructions
  };
  allSkills.push(skill);
  await saveSkillInstructions(id, instructions);
  await persistAll();
  return { ...skill };
}
async function persistAll() {
  const data = allSkills.map((s) => {
    const { instructions: _, ...rest } = s;
    return { ...rest, instructionsFile: `${s.id}/SKILL.md` };
  });
  await savePersistedSkills(data);
}
function toRawGitHubUrl(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/(?:blob\/)?(.+)/);
  if (m) {
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  return url;
}
function parseSkillMeta(content) {
  const meta = {};
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const kv = line.match(/^(\w+)\s*:\s*(.+)/);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
    }
  }
  if (!meta.name) {
    const titleMatch = content.match(/^#\s+(.+)/m);
    if (titleMatch) meta.name = titleMatch[1].trim();
  }
  return meta;
}

// src/main/agent.ts
init_notes();
var pendingConfirms = /* @__PURE__ */ new Map();
function isAbortError2(err) {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message === "AbortError" || err.message === "Aborted";
}
function resolveConfirm(confirmId, approved) {
  const resolver = pendingConfirms.get(confirmId);
  if (resolver) {
    resolver(approved);
    pendingConfirms.delete(confirmId);
  }
}
function waitForConfirm(confirmId, signal) {
  return new Promise((resolve2) => {
    pendingConfirms.set(confirmId, resolve2);
    if (signal?.aborted) {
      pendingConfirms.delete(confirmId);
      resolve2(false);
      return;
    }
    const onAbort = () => {
      pendingConfirms.delete(confirmId);
      resolve2(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
var MAX_TOOL_ROUNDS = 1e3;
var confirmCounter = 0;
function estimateTokens(text) {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.2 + other * 0.25);
}
var MAX_SINGLE_MSG_CHARS = 32e3;
async function summarizeMessages(provider, overrides, messagesToSummarize, signal, logScope) {
  const lines = [];
  for (const m of messagesToSummarize) {
    const role = m.role === "assistant" ? "AI\u52A9\u624B" : m.role === "user" ? "\u7528\u6237" : m.role === "tool" ? "\u5DE5\u5177\u7ED3\u679C" : "\u7CFB\u7EDF";
    const content = m.content.length > 8e3 ? m.content.slice(0, 8e3) + "...[\u622A\u65AD]" : m.content;
    lines.push(`[${role}] ${content}`);
  }
  const conversationText = lines.join("\n\n");
  const summaryPrompt = [
    {
      role: "system",
      content: `\u4F60\u662F\u4E00\u4E2A\u5BF9\u8BDD\u6458\u8981\u52A9\u624B\u3002\u4F60\u9700\u8981\u5C06\u4E00\u6BB5 AI Agent \u7684\u5BF9\u8BDD\u5386\u53F2\u538B\u7F29\u6210\u7CBE\u70BC\u7684\u6458\u8981\u3002

\u8981\u6C42\uFF1A
1. \u4FDD\u7559\u6240\u6709\u5173\u952E\u4FE1\u606F\uFF1A\u7528\u6237\u7684\u539F\u59CB\u9700\u6C42\u3001AI\u5DF2\u5B8C\u6210\u7684\u64CD\u4F5C\u6B65\u9AA4\u3001\u4FEE\u6539\u7684\u6587\u4EF6\u5217\u8868\u3001\u9047\u5230\u7684\u95EE\u9898\u548C\u89E3\u51B3\u65B9\u6848
2. \u4FDD\u7559\u91CD\u8981\u7684\u6280\u672F\u7EC6\u8282\uFF1A\u6587\u4EF6\u8DEF\u5F84\u3001\u51FD\u6570\u540D\u3001\u914D\u7F6E\u9879\u3001\u547D\u4EE4\u7B49
3. \u4FDD\u7559\u5F53\u524D\u7684\u5DE5\u4F5C\u8FDB\u5C55\u548C\u5F85\u529E\u4E8B\u9879
4. \u4F7F\u7528\u7ED3\u6784\u5316\u683C\u5F0F\uFF0C\u6761\u7406\u6E05\u6670
5. \u6458\u8981\u957F\u5EA6\u63A7\u5236\u5728 1500 \u5B57\u4EE5\u5185
6. \u4F7F\u7528\u4E2D\u6587\u8F93\u51FA`
    },
    {
      role: "user",
      content: `\u8BF7\u5C06\u4EE5\u4E0B\u5BF9\u8BDD\u5386\u53F2\u538B\u7F29\u6210\u7CBE\u70BC\u7684\u6458\u8981\uFF1A

${conversationText}`
    }
  ];
  try {
    const summary = await requestChatCompletion(provider, summaryPrompt, overrides, signal, logScope);
    return summary;
  } catch (err) {
    if (isAbortError2(err) || signal?.aborted) throw err;
    log("SUMMARIZE_FAIL", { error: err instanceof Error ? err.message : String(err) }, logScope);
    return messagesToSummarize.map((m) => {
      const tag = m.role === "assistant" ? "AI" : m.role === "user" ? "User" : m.role;
      return `[${tag}] ${m.content.slice(0, 200)}`;
    }).join("\n");
  }
}
async function compressAgentContext(msgs, tokenBudget, provider, overrides, signal, logScope) {
  const threshold = Math.floor(tokenBudget * 0.7);
  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.content && m.content.length > MAX_SINGLE_MSG_CHARS) {
      const truncated = m.content.slice(0, MAX_SINGLE_MSG_CHARS);
      msgs[i] = { ...m, content: truncated + "\n\n[...\u5185\u5BB9\u5DF2\u622A\u65AD\u4EE5\u9002\u914D\u4E0A\u4E0B\u6587\u7A97\u53E3]" };
    }
  }
  let total = msgs.reduce((s, m) => s + estimateTokens(m.content), 0);
  if (total <= threshold) return 0;
  const minKeep = Math.min(8, msgs.length - 1);
  const compressEnd = msgs.length - minKeep;
  if (compressEnd <= 1) return 0;
  const toCompress = msgs.slice(1, compressEnd);
  const compressCount = toCompress.length;
  log("AGENT_CONTEXT_SUMMARIZE_START", {
    totalTokens: total,
    budget: tokenBudget,
    compressCount,
    keepCount: minKeep
  }, logScope);
  const summary = await summarizeMessages(provider, overrides, toCompress, signal, logScope);
  const summaryMsg = {
    role: "system",
    content: `[\u5BF9\u8BDD\u5386\u53F2\u6458\u8981 \u2014 \u4EE5\u4E0B\u662F\u4E4B\u524D ${compressCount} \u6761\u6D88\u606F\u7684 AI \u603B\u7ED3]

${summary}

[\u6458\u8981\u7ED3\u675F \u2014 \u8BF7\u57FA\u4E8E\u4EE5\u4E0A\u6458\u8981\u548C\u540E\u7EED\u7684\u6700\u65B0\u6D88\u606F\u7EE7\u7EED\u5DE5\u4F5C]`
  };
  msgs.splice(1, compressCount, summaryMsg);
  const newTotal = msgs.reduce((s, m) => s + estimateTokens(m.content), 0);
  log("AGENT_CONTEXT_SUMMARIZE_DONE", {
    compressed: compressCount,
    beforeTokens: total,
    afterTokens: newTotal,
    budget: tokenBudget
  }, logScope);
  return compressCount;
}
async function runAgent(provider, messages, overrides, workspace, onEvent, maxTokens, signal, projectId, logScope) {
  try {
    await gitEnsureRepo(workspace);
  } catch (err) {
    log("GIT_INIT_FAIL", { error: err instanceof Error ? err.message : String(err) }, logScope);
  }
  const skillInstructions = getActiveSkillInstructions();
  const workingMessages = [...messages];
  if (workingMessages.length > 0 && workingMessages[0].role === "system") {
    let extraPrompt = "";
    if (skillInstructions.length > 0) {
      extraPrompt += "\n\n# \u5DF2\u542F\u7528\u7684 Skills\n\u4EE5\u4E0B\u662F\u4F60\u5E94\u5F53\u9075\u5FAA\u7684\u989D\u5916\u80FD\u529B\u6307\u4EE4\uFF1A\n\n" + skillInstructions.join("\n\n---\n\n");
    }
    try {
      const notesBlock = await getNotesPromptBlock(workspace, projectId);
      if (notesBlock) extraPrompt += notesBlock;
    } catch (err) {
      log("NOTES_LOAD_FAIL", { error: err instanceof Error ? err.message : String(err) }, logScope);
    }
    try {
      const tree = await getWorkspaceTree(workspace, 6, true);
      if (tree) {
        extraPrompt += "\n\n# \u5F53\u524D\u5DE5\u4F5C\u7A7A\u95F4\u76EE\u5F55\u7ED3\u6784\n\u4EE5\u4E0B\u662F\u9879\u76EE\u76EE\u5F55\u6811\uFF08\u81EA\u52A8\u751F\u6210\uFF0C\u65E0\u9700\u518D\u6B21\u8C03\u7528 list_directory \u67E5\u770B\u6839\u76EE\u5F55\u7ED3\u6784\uFF09\uFF1A\n```\n" + tree + "\n```\n\u6CE8\u610F\uFF1A\u6B64\u76EE\u5F55\u6811\u5728\u5BF9\u8BDD\u5F00\u59CB\u65F6\u751F\u6210\u3002\u5982\u679C\u4F60\u5728\u6267\u884C\u8FC7\u7A0B\u4E2D\u521B\u5EFA\u4E86\u65B0\u6587\u4EF6\uFF0C\u76EE\u5F55\u6811\u4E0D\u4F1A\u5B9E\u65F6\u66F4\u65B0\uFF0C\u53EF\u6309\u9700\u8C03\u7528 list_directory \u67E5\u770B\u6700\u65B0\u72B6\u6001\u3002";
      }
    } catch (err) {
      log("WORKSPACE_TREE_FAIL", { error: err instanceof Error ? err.message : String(err) }, logScope);
    }
    if (extraPrompt) {
      workingMessages[0] = { ...workingMessages[0], content: workingMessages[0].content + extraPrompt };
    }
  }
  let round = 0;
  let hasFileChanges = false;
  let currentPlan = null;
  function trackFileChanges(results) {
    for (const r of results) {
      if (r.fileChange) {
        hasFileChanges = true;
        break;
      }
    }
  }
  async function autoCommit() {
    if (!hasFileChanges) return;
    try {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const summary = lastUserMsg?.content ? lastUserMsg.content.replace(/[\n\r]+/g, " ").slice(0, 60) : `Agent round ${round}`;
      const hash = await gitCommit(workspace, summary);
      if (hash) {
        log("GIT_COMMIT", { hash, message: summary }, logScope);
        onEvent?.({ type: "git_commit", hash, message: summary });
      }
    } catch (err) {
      log("GIT_COMMIT_FAIL", { error: err instanceof Error ? err.message : String(err) }, logScope);
    }
  }
  const tokenBudget = maxTokens ?? 131072;
  let contextRetries = 0;
  while (round < MAX_TOOL_ROUNDS) {
    if (signal?.aborted) {
      log("AGENT_ABORTED", { round, reason: "signal aborted before round start" }, logScope);
      await autoCommit();
      onEvent?.({ type: "done" });
      return;
    }
    round++;
    try {
      await compressAgentContext(workingMessages, tokenBudget, provider, overrides, signal, logScope);
    } catch (err) {
      if (isAbortError2(err) || signal?.aborted) {
        log("AGENT_ABORTED", { round, reason: "signal aborted during context compress" }, logScope);
        await autoCommit();
        onEvent?.({ type: "done" });
        return;
      }
      onEvent?.({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    log("AGENT", { round, messageCount: workingMessages.length }, logScope);
    let textContent = "";
    let toolCalls = [];
    try {
      for await (const event of requestStreamWithTools(
        provider,
        workingMessages,
        overrides,
        { tools: getAllToolDefinitions() },
        signal,
        logScope
      )) {
        if (signal?.aborted) {
          log("AGENT_ABORTED", { round, reason: "signal aborted during stream" }, logScope);
          await autoCommit();
          onEvent?.({ type: "done" });
          return;
        }
        if (event.type === "text") {
          textContent += event.content;
          onEvent?.({ type: "text", content: event.content });
        } else if (event.type === "tool_calls") {
          toolCalls = event.toolCalls;
        }
      }
    } catch (err) {
      if (isAbortError2(err) || signal?.aborted) {
        log("AGENT_ABORTED", { round, reason: "signal aborted during stream request" }, logScope);
        await autoCommit();
        onEvent?.({ type: "done" });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (contextRetries < 3 && (msg.includes("context length") || msg.includes("maximum") || msg.includes("too many tokens") || msg.includes("\u8BF7\u6C42\u4F53\u8FC7\u957F"))) {
        contextRetries++;
        log("AGENT_CONTEXT_OVERFLOW", { round, retry: contextRetries, error: msg }, logScope);
        const dropped = await compressAgentContext(workingMessages, Math.floor(tokenBudget * 0.5), provider, overrides, signal, logScope);
        if (dropped > 0) {
          log("AGENT_CONTEXT_RETRY", { dropped, newMsgCount: workingMessages.length }, logScope);
          round--;
          continue;
        }
      }
      onEvent?.({ type: "error", message: msg });
      return;
    }
    if (toolCalls.length === 0) {
      await autoCommit();
      onEvent?.({ type: "done" });
      return;
    }
    workingMessages.push({
      role: "assistant",
      content: textContent || "",
      tool_calls: toolCalls
    });
    onEvent?.({ type: "tool_calls", toolCalls });
    const NOTE_TOOLS = /* @__PURE__ */ new Set(["save_note", "delete_note"]);
    const noteToolCalls = toolCalls.filter((tc) => NOTE_TOOLS.has(tc.function.name));
    if (noteToolCalls.length > 0) {
      const noteResults = await executeToolCalls(noteToolCalls, workspace, signal, logScope, projectId);
      if (signal?.aborted) {
        log("AGENT_ABORTED", { round, reason: "signal aborted during note tools" }, logScope);
        await autoCommit();
        onEvent?.({ type: "done" });
        return;
      }
      onEvent?.({ type: "tool_results", results: noteResults });
      for (const result of noteResults) {
        workingMessages.push({
          role: "tool",
          content: result.content,
          tool_call_id: result.tool_call_id
        });
      }
      if (noteToolCalls.length === toolCalls.length) continue;
      toolCalls = toolCalls.filter((tc) => !NOTE_TOOLS.has(tc.function.name));
    }
    const planProgressCalls = toolCalls.filter((tc) => tc.function.name === "update_plan_progress");
    if (planProgressCalls.length > 0) {
      for (const tc of planProgressCalls) {
        try {
          const args = JSON.parse(tc.function.arguments);
          const stepIdx = args.stepIndex;
          const status = args.status;
          const note = args.note;
          if (currentPlan && stepIdx >= 0 && stepIdx < currentPlan.steps.length) {
            currentPlan.steps[stepIdx].status = status;
            if (note) currentPlan.steps[stepIdx].note = note;
          }
          onEvent?.({ type: "plan_progress", stepIndex: stepIdx, status, note });
          const resultContent = `\u6B65\u9AA4 ${stepIdx + 1} \u72B6\u6001\u5DF2\u66F4\u65B0\u4E3A\u300C${status}\u300D${note ? `\uFF1A${note}` : ""}`;
          onEvent?.({ type: "tool_results", results: [{ tool_call_id: tc.id, name: tc.function.name, content: resultContent, success: true }] });
          workingMessages.push({ role: "tool", content: resultContent, tool_call_id: tc.id });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          onEvent?.({ type: "tool_results", results: [{ tool_call_id: tc.id, name: tc.function.name, content: `\u66F4\u65B0\u5931\u8D25: ${errMsg}`, success: false }] });
          workingMessages.push({ role: "tool", content: `\u66F4\u65B0\u5931\u8D25: ${errMsg}`, tool_call_id: tc.id });
        }
      }
      if (planProgressCalls.length === toolCalls.length) continue;
      toolCalls = toolCalls.filter((tc) => tc.function.name !== "update_plan_progress");
    }
    const planCall = toolCalls.find((tc) => tc.function.name === "propose_plan");
    if (planCall) {
      const confirmId = `plan-${Date.now()}-${++confirmCounter}`;
      log("AGENT_PLAN", { confirmId, plan: planCall.function.arguments }, logScope);
      const planRisks = [{
        toolCallId: planCall.id,
        toolName: "propose_plan",
        level: "warning",
        reason: "\u6267\u884C\u8BA1\u5212\u9700\u8981\u786E\u8BA4",
        detail: planCall.function.arguments
      }];
      onEvent?.({ type: "confirm", confirmId, toolCalls: [planCall], risks: planRisks });
      const approved = await waitForConfirm(confirmId, signal);
      log("AGENT_PLAN_CONFIRM", { confirmId, approved }, logScope);
      if (signal?.aborted) {
        log("AGENT_ABORTED", { round, reason: "signal aborted during plan confirm" }, logScope);
        await autoCommit();
        onEvent?.({ type: "done" });
        return;
      }
      if (!approved) {
        const deniedResults = toolCalls.map((tc) => ({
          tool_call_id: tc.id,
          name: tc.function.name,
          content: tc.function.name === "propose_plan" ? "\u7528\u6237\u6CA1\u6709\u6279\u51C6\u6B64\u6267\u884C\u8BA1\u5212\u3002\u8BF7\u6839\u636E\u7528\u6237\u7684\u53CD\u9988\u8C03\u6574\u65B9\u6848\uFF0C\u6216\u8005\u8BE2\u95EE\u7528\u6237\u5E0C\u671B\u5982\u4F55\u4FEE\u6539\u3002\u4E0D\u8981\u76F4\u63A5\u5F00\u59CB\u6267\u884C\u672A\u7ECF\u786E\u8BA4\u7684\u64CD\u4F5C\u3002" : "\u8BA1\u5212\u672A\u83B7\u6279\u51C6\uFF0C\u6B64\u64CD\u4F5C\u88AB\u53D6\u6D88\u3002",
          success: false
        }));
        onEvent?.({ type: "tool_results", results: deniedResults });
        for (const result of deniedResults) {
          workingMessages.push({
            role: "tool",
            content: result.content,
            tool_call_id: result.tool_call_id
          });
        }
        continue;
      }
      try {
        const planArgs = JSON.parse(planCall.function.arguments);
        const steps = planArgs.steps || [];
        currentPlan = {
          summary: planArgs.summary || "",
          reasoning: planArgs.reasoning,
          steps: steps.map((s) => ({ text: s, status: "pending" }))
        };
        onEvent?.({ type: "plan_init", summary: currentPlan.summary, steps, reasoning: currentPlan.reasoning });
        log("PLAN_INIT", { summary: currentPlan.summary, stepCount: steps.length }, logScope);
      } catch (e) {
        log("PLAN_INIT_PARSE_FAIL", { error: e instanceof Error ? e.message : String(e) }, logScope);
      }
      const planResult = {
        tool_call_id: planCall.id,
        name: "propose_plan",
        content: '\u7528\u6237\u5DF2\u786E\u8BA4\u6B64\u6267\u884C\u8BA1\u5212\uFF0C\u8BF7\u6309\u7167\u8BA1\u5212\u5F00\u59CB\u6267\u884C\u3002\u8BF7\u5728\u5F00\u59CB\u6267\u884C\u6BCF\u4E2A\u6B65\u9AA4\u524D\u8C03\u7528 update_plan_progress(stepIndex, "in_progress")\uFF0C\u5B8C\u6210\u540E\u8C03\u7528 update_plan_progress(stepIndex, "done")\uFF0C\u4EE5\u4FBF\u7528\u6237\u5B9E\u65F6\u770B\u5230\u6267\u884C\u8FDB\u5EA6\u3002',
        success: true
      };
      if (toolCalls.length === 1) {
        onEvent?.({ type: "tool_results", results: [planResult] });
        workingMessages.push({
          role: "tool",
          content: planResult.content,
          tool_call_id: planResult.tool_call_id
        });
        continue;
      }
      workingMessages.push({
        role: "tool",
        content: planResult.content,
        tool_call_id: planResult.tool_call_id
      });
      const otherToolCalls = toolCalls.filter((tc) => tc.function.name !== "propose_plan");
      const otherResults = await executeToolCalls(otherToolCalls, workspace, signal, logScope, projectId);
      if (signal?.aborted) {
        log("AGENT_ABORTED", { round, reason: "signal aborted during plan tools" }, logScope);
        await autoCommit();
        onEvent?.({ type: "done" });
        return;
      }
      trackFileChanges(otherResults);
      const allResults = [planResult, ...otherResults];
      onEvent?.({ type: "tool_results", results: allResults });
      for (const result of otherResults) {
        workingMessages.push({
          role: "tool",
          content: result.content,
          tool_call_id: result.tool_call_id
        });
      }
      continue;
    }
    const risks = assessToolCallsRisk(toolCalls);
    if (risks.length > 0) {
      const confirmId = `confirm-${Date.now()}-${++confirmCounter}`;
      log("AGENT_RISK", { confirmId, risks }, logScope);
      onEvent?.({ type: "confirm", confirmId, toolCalls, risks });
      const approved = await waitForConfirm(confirmId, signal);
      log("AGENT_CONFIRM", { confirmId, approved }, logScope);
      if (signal?.aborted) {
        log("AGENT_ABORTED", { round, reason: "signal aborted during risk confirm" }, logScope);
        await autoCommit();
        onEvent?.({ type: "done" });
        return;
      }
      if (!approved) {
        const deniedResults = toolCalls.map((tc) => ({
          tool_call_id: tc.id,
          name: tc.function.name,
          content: "\u7528\u6237\u62D2\u7EDD\u4E86\u6B64\u64CD\u4F5C\u7684\u6267\u884C\u3002\u8BF7\u544A\u77E5\u7528\u6237\u4F60\u539F\u672C\u6253\u7B97\u6267\u884C\u7684\u64CD\u4F5C\uFF0C\u5E76\u8BE2\u95EE\u662F\u5426\u9700\u8981\u5176\u4ED6\u65B9\u5F0F\u6765\u5B8C\u6210\u4EFB\u52A1\u3002",
          success: false
        }));
        onEvent?.({ type: "tool_results", results: deniedResults });
        for (const result of deniedResults) {
          workingMessages.push({
            role: "tool",
            content: result.content,
            tool_call_id: result.tool_call_id
          });
        }
        continue;
      }
      const hasBrowserRisk = risks.some((r) => r.toolName.startsWith("browser_"));
      if (hasBrowserRisk) {
        setBrowserAutoApproved(true);
        log("BROWSER_AUTO_APPROVED", { msg: "\u7528\u6237\u5DF2\u786E\u8BA4\u6D4F\u89C8\u5668\u64CD\u4F5C\uFF0C\u540E\u7EED\u81EA\u52A8\u653E\u884C" }, logScope);
      }
    }
    if (signal?.aborted) {
      log("AGENT_ABORTED", { round, reason: "signal aborted before tool execution" }, logScope);
      await autoCommit();
      onEvent?.({ type: "done" });
      return;
    }
    const results = await executeToolCalls(toolCalls, workspace, signal, logScope, projectId);
    if (signal?.aborted) {
      log("AGENT_ABORTED", { round, reason: "signal aborted during tool execution" }, logScope);
      await autoCommit();
      onEvent?.({ type: "done" });
      return;
    }
    trackFileChanges(results);
    onEvent?.({ type: "tool_results", results });
    for (const result of results) {
      let content = result.content;
      if (content.length > MAX_SINGLE_MSG_CHARS) {
        content = content.slice(0, MAX_SINGLE_MSG_CHARS) + "\n\n[...\u8F93\u51FA\u5DF2\u622A\u65AD\uFF0C\u5171 " + result.content.length + " \u5B57\u7B26]";
      }
      workingMessages.push({
        role: "tool",
        content,
        tool_call_id: result.tool_call_id
      });
    }
  }
  await autoCommit();
  onEvent?.({ type: "error", message: `Agent exceeded max tool rounds (${MAX_TOOL_ROUNDS})` });
}

// src/main/ipc.ts
init_notes();

// src/main/terminal.ts
var pty = __toESM(require("node-pty"), 1);
var terminalProcesses = /* @__PURE__ */ new Map();
function getShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || "/bin/zsh";
}
function handleTerminalSpawn(event, payload) {
  const senderId = event.sender.id;
  const existing = terminalProcesses.get(senderId);
  if (existing) {
    try {
      existing.kill();
    } catch {
    }
    terminalProcesses.delete(senderId);
  }
  const shell2 = getShell();
  const cwd = payload.cwd || process.env.HOME || "/";
  try {
    const ptyProcess = pty.spawn(shell2, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor"
      }
    });
    terminalProcesses.set(senderId, ptyProcess);
    ptyProcess.onData((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannel.TERMINAL_OUTPUT, data);
      }
    });
    ptyProcess.onExit(({ exitCode }) => {
      terminalProcesses.delete(senderId);
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannel.TERMINAL_EXIT, { code: exitCode });
      }
    });
  } catch (err) {
    console.error("Terminal spawn failed:", err);
    if (!event.sender.isDestroyed()) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      event.sender.send(
        IpcChannel.TERMINAL_OUTPUT,
        `\r
\x1B[31m\u7EC8\u7AEF\u542F\u52A8\u5931\u8D25: ${msg}\x1B[0m\r
\x1B[33m\u8BF7\u5C1D\u8BD5: chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper\x1B[0m\r
`
      );
      event.sender.send(IpcChannel.TERMINAL_EXIT, { code: -1 });
    }
  }
}
function handleTerminalInput(event, data) {
  const ptyProcess = terminalProcesses.get(event.sender.id);
  if (ptyProcess) {
    ptyProcess.write(data);
  }
}
function handleTerminalResize(event, payload) {
  const ptyProcess = terminalProcesses.get(event.sender.id);
  if (ptyProcess && payload.cols > 0 && payload.rows > 0) {
    try {
      ptyProcess.resize(payload.cols, payload.rows);
    } catch {
    }
  }
}
function handleTerminalKill(event) {
  const ptyProcess = terminalProcesses.get(event.sender.id);
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {
    }
    terminalProcesses.delete(event.sender.id);
  }
}

// src/main/ipc.ts
function buildLogScope(projectId, workspace) {
  if (projectId && projectId.trim()) return `project:${projectId.trim()}`;
  if (workspace && workspace.trim()) return `workspace:${nodePath2.resolve(workspace.trim())}`;
  return void 0;
}
async function handleChatSend(_event, payload) {
  const logScope = buildLogScope(payload.projectId, void 0);
  return await requestChatCompletion(
    payload.provider,
    payload.messages,
    payload.overrides,
    void 0,
    logScope
  );
}
async function handleChatStream(event, payload) {
  const { requestId, provider, messages, overrides, projectId, workspace } = payload;
  const logScope = buildLogScope(projectId, workspace);
  const abortController = new AbortController();
  chatAbortControllers.set(requestId, abortController);
  try {
    for await (const chunk of requestChatCompletionStream(
      provider,
      messages,
      overrides,
      abortController.signal,
      logScope
    )) {
      if (event.sender.isDestroyed()) return;
      event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk, done: false });
    }
    if (!event.sender.isDestroyed()) {
      event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk: "", done: true });
    }
  } catch (error) {
    const aborted = abortController.signal.aborted || error instanceof Error && error.name === "AbortError";
    if (aborted) {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk: "", done: true });
      }
      return;
    }
    if (!event.sender.isDestroyed()) {
      event.sender.send(IpcChannel.CHAT_CHUNK, {
        requestId,
        chunk: "",
        done: true,
        error: error instanceof Error ? error.message : "Stream failed"
      });
    }
  } finally {
    chatAbortControllers.delete(requestId);
  }
}
var chatAbortControllers = /* @__PURE__ */ new Map();
var agentAbortControllers = /* @__PURE__ */ new Map();
async function handleAgentStream(event, payload) {
  const { requestId, provider, messages, overrides, workspace, maxTokens, images, projectId } = payload;
  const logScope = buildLogScope(projectId, workspace);
  if (images && images.length > 0) {
    try {
      const savedPaths = [];
      for (const dataUrl of images) {
        const filePath = await saveScreenshot(dataUrl);
        savedPaths.push(filePath);
        log("IMAGE_SAVED", { filePath }, logScope);
      }
      const lastUserIdx = messages.length - 1;
      if (lastUserIdx >= 0 && messages[lastUserIdx].role === "user") {
        const pathList = savedPaths.map((p, i) => savedPaths.length > 1 ? `  ${i + 1}. ${p}` : p).join("\n");
        const hint = `

[\u7528\u6237\u9644\u5E26\u4E86${savedPaths.length > 1 ? ` ${savedPaths.length} \u5F20` : ""}\u56FE\u7247]
\u56FE\u7247\u8DEF\u5F84:
${pathList}
\u5982\u9700\u5206\u6790\u56FE\u7247\uFF0C\u53EF\u5148\u8C03\u7528 mcp_list_tools \u67E5\u770B minimax \u4E0B understand_image \u7684\u6700\u65B0 inputSchema\uFF0C\u518D\u4F7F\u7528 mcp_call \u4F20\u5165\u53C2\u6570\u3002`;
        messages[lastUserIdx] = {
          ...messages[lastUserIdx],
          content: messages[lastUserIdx].content + hint
        };
      }
    } catch (imgErr) {
      log("IMAGE_PROCESS_FAIL", { error: imgErr instanceof Error ? imgErr.message : String(imgErr) }, logScope);
    }
  }
  const abortController = new AbortController();
  agentAbortControllers.set(requestId, abortController);
  try {
    await runAgent(
      provider,
      messages,
      overrides,
      workspace,
      (agentEvent) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send(IpcChannel.AGENT_EVENT, { requestId, ...agentEvent });
      },
      maxTokens,
      abortController.signal,
      projectId,
      logScope
    );
  } finally {
    agentAbortControllers.delete(requestId);
  }
}
function handleAgentAbort(_event, requestId) {
  const controller = agentAbortControllers.get(requestId);
  if (controller) {
    controller.abort();
    agentAbortControllers.delete(requestId);
  }
}
function handleChatAbort(_event, requestId) {
  const controller = chatAbortControllers.get(requestId);
  if (controller) {
    controller.abort();
    chatAbortControllers.delete(requestId);
  }
}
function handleAgentConfirm(_event, payload) {
  resolveConfirm(payload.confirmId, payload.approved);
}
async function handleSelectDirectory(event) {
  const win = import_electron5.BrowserWindow.fromWebContents(event.sender);
  const result = await import_electron5.dialog.showOpenDialog(win, {
    title: "\u9009\u62E9\u5DE5\u4F5C\u7A7A\u95F4\u76EE\u5F55",
    properties: ["openDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}
async function handleOpenInEditor(_event, filePath, editor) {
  const entry = editorCommands[editor];
  if (!entry) throw new Error(`Unknown editor: ${editor}`);
  let cmd;
  if (process.platform === "darwin") {
    cmd = editor === "system" ? `open "${filePath}"` : `open -a "${entry.macApp}" "${filePath}"`;
  } else if (process.platform === "win32") {
    cmd = editor === "system" ? `start "" "${filePath}"` : `"${entry.cli}" "${filePath}"`;
  } else {
    cmd = editor === "system" ? `xdg-open "${filePath}"` : `${entry.cli} "${filePath}"`;
  }
  return new Promise((resolve2, reject) => {
    (0, import_node_child_process5.exec)(cmd, (err) => {
      if (err) reject(new Error(`\u6253\u5F00\u6587\u4EF6\u5931\u8D25: ${err.message}`));
      else resolve2();
    });
  });
}
var EXCLUDED_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".DS_Store",
  "__pycache__",
  ".cache",
  "coverage",
  ".idea"
]);
async function readWorkspaceTree(dir, basePath = "", depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = await fs6.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const relPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const children = await readWorkspaceTree(
        nodePath2.join(dir, entry.name),
        relPath,
        depth + 1,
        maxDepth
      );
      result.push({ name: entry.name, path: relPath, isDirectory: true, children });
    } else {
      result.push({ name: entry.name, path: relPath, isDirectory: false });
    }
  }
  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}
var activeWatcher = null;
var activeWatchPath = null;
var watchDebounce = null;
function startWatching(cwd, win) {
  stopWatching();
  activeWatchPath = cwd;
  try {
    activeWatcher = (0, import_node_fs3.watch)(cwd, { recursive: true }, (_eventType, filename) => {
      if (filename) {
        const top = filename.toString().split(/[/\\]/)[0];
        if (EXCLUDED_DIRS.has(top)) return;
      }
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        watchDebounce = null;
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannel.WORKSPACE_CHANGED);
        }
      }, 500);
    });
  } catch (err) {
    console.error("\u5DE5\u4F5C\u533A\u6587\u4EF6\u76D1\u542C\u542F\u52A8\u5931\u8D25:", err);
  }
}
function stopWatching() {
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = null;
  }
  if (activeWatcher) {
    activeWatcher.close();
    activeWatcher = null;
  }
  activeWatchPath = null;
}
async function handleFileRevert(_event, filePath, oldContent) {
  try {
    const dir = nodePath2.dirname(filePath);
    await fs6.mkdir(dir, { recursive: true });
    await fs6.writeFile(filePath, oldContent, "utf-8");
  } catch (err) {
    throw err;
  }
}
async function handleFileDelete(_event, filePath) {
  try {
    await fs6.unlink(filePath);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
}
function isBinaryBuffer(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
async function handleFileRead(_event, filePath) {
  const stat2 = await fs6.stat(filePath);
  const size = stat2.size;
  if (size > 5 * 1024 * 1024) {
    return { content: null, size, isBinary: true };
  }
  const buf = Buffer.from(await fs6.readFile(filePath));
  if (isBinaryBuffer(buf)) {
    return { content: null, size, isBinary: true };
  }
  return { content: buf.toString("utf-8"), size, isBinary: false };
}
async function handleFileWrite(_event, filePath, content) {
  const dir = nodePath2.dirname(filePath);
  await fs6.mkdir(dir, { recursive: true });
  await fs6.writeFile(filePath, content, "utf-8");
}
var dragState = /* @__PURE__ */ new Map();
function handleWindowDragStart(event, pos) {
  const win = import_electron5.BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const [winX, winY] = win.getPosition();
  dragState.set(win.id, {
    offsetX: pos.screenX - winX,
    offsetY: pos.screenY - winY
  });
}
function handleWindowDragging(event, pos) {
  const win = import_electron5.BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const state = dragState.get(win.id);
  if (!state) return;
  win.setPosition(pos.screenX - state.offsetX, pos.screenY - state.offsetY);
}
function handleWindowDragEnd(event) {
  const win = import_electron5.BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  dragState.delete(win.id);
}
function handleWindowToggleMaximize(event) {
  const win = import_electron5.BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
}
function registerIpcHandlers() {
  import_electron5.ipcMain.handle(IpcChannel.CHAT_SEND, handleChatSend);
  import_electron5.ipcMain.handle(IpcChannel.SELECT_DIRECTORY, handleSelectDirectory);
  import_electron5.ipcMain.handle(IpcChannel.OPEN_IN_EDITOR, handleOpenInEditor);
  import_electron5.ipcMain.handle(IpcChannel.OPEN_LOG_DIR, (_e, scope) => {
    const logScope = buildLogScope(scope?.projectId, scope?.workspace);
    return import_electron5.shell.openPath(getLogDir(logScope));
  });
  import_electron5.ipcMain.handle(IpcChannel.FILE_REVERT, handleFileRevert);
  import_electron5.ipcMain.handle(IpcChannel.FILE_DELETE, handleFileDelete);
  import_electron5.ipcMain.handle(IpcChannel.FILE_READ, handleFileRead);
  import_electron5.ipcMain.handle(IpcChannel.FILE_WRITE, handleFileWrite);
  import_electron5.ipcMain.on(IpcChannel.CHAT_STREAM, handleChatStream);
  import_electron5.ipcMain.on(IpcChannel.CHAT_ABORT, handleChatAbort);
  import_electron5.ipcMain.on(IpcChannel.AGENT_STREAM, handleAgentStream);
  import_electron5.ipcMain.on(IpcChannel.AGENT_CONFIRM, handleAgentConfirm);
  import_electron5.ipcMain.on(IpcChannel.AGENT_ABORT, handleAgentAbort);
  import_electron5.ipcMain.on(IpcChannel.AGENT_AUTO_APPROVE, (_e, categories) => {
    setAutoApproveCategories(categories);
  });
  import_electron5.ipcMain.on(IpcChannel.TERMINAL_SPAWN, handleTerminalSpawn);
  import_electron5.ipcMain.on(IpcChannel.TERMINAL_INPUT, handleTerminalInput);
  import_electron5.ipcMain.on(IpcChannel.TERMINAL_RESIZE, handleTerminalResize);
  import_electron5.ipcMain.on(IpcChannel.TERMINAL_KILL, handleTerminalKill);
  import_electron5.ipcMain.handle(IpcChannel.WORKSPACE_TREE, (_e, cwd) => readWorkspaceTree(cwd));
  import_electron5.ipcMain.on(IpcChannel.WORKSPACE_WATCH, (e, cwd) => {
    const senderWin = import_electron5.BrowserWindow.fromWebContents(e.sender);
    if (senderWin) startWatching(cwd, senderWin);
  });
  import_electron5.ipcMain.on(IpcChannel.WORKSPACE_UNWATCH, () => {
    stopWatching();
  });
  import_electron5.ipcMain.handle(IpcChannel.GIT_LOG, (_e, cwd) => gitLog(cwd));
  import_electron5.ipcMain.handle(IpcChannel.GIT_COMMIT, (_e, cwd, msg) => gitCommit(cwd, msg));
  import_electron5.ipcMain.handle(IpcChannel.GIT_ROLLBACK, (_e, cwd, hash) => gitRollback(cwd, hash));
  import_electron5.ipcMain.handle(IpcChannel.GIT_COMMIT_FILES, (_e, cwd, hash) => gitCommitFiles(cwd, hash));
  import_electron5.ipcMain.on(IpcChannel.WINDOW_DRAG_START, handleWindowDragStart);
  import_electron5.ipcMain.on(IpcChannel.WINDOW_DRAGGING, handleWindowDragging);
  import_electron5.ipcMain.on(IpcChannel.WINDOW_DRAG_END, handleWindowDragEnd);
  import_electron5.ipcMain.on(IpcChannel.WINDOW_TOGGLE_MAXIMIZE, handleWindowToggleMaximize);
  initSkills().catch((err) => console.error("Skills \u521D\u59CB\u5316\u5931\u8D25:", err));
  import_electron5.ipcMain.handle(IpcChannel.SKILLS_LIST, () => listSkills());
  import_electron5.ipcMain.handle(IpcChannel.SKILLS_INSTALL, (_e, source) => installSkill(source));
  import_electron5.ipcMain.handle(IpcChannel.SKILLS_UNINSTALL, (_e, id) => uninstallSkill(id));
  import_electron5.ipcMain.handle(IpcChannel.SKILLS_TOGGLE, (_e, id, enabled) => toggleSkill(id, enabled));
  import_electron5.ipcMain.handle(IpcChannel.NOTES_LIST, (_e, workspace, projectId) => listNotes(workspace, projectId));
  import_electron5.ipcMain.handle(IpcChannel.NOTES_SAVE, (_e, workspace, note, projectId) => saveNote(workspace, note, projectId));
  import_electron5.ipcMain.handle(IpcChannel.NOTES_DELETE, (_e, workspace, noteId, projectId) => deleteNote(workspace, noteId, projectId));
  import_electron5.ipcMain.on(IpcChannel.BROWSER_AUTO_TAKEOVER, (_e, enabled) => {
    setBrowserAutoApproved(enabled);
  });
  initMcp().catch((err) => console.error("MCP \u521D\u59CB\u5316\u5931\u8D25:", err));
  import_electron5.ipcMain.handle(IpcChannel.MCP_LIST, () => listMcpServers());
  import_electron5.ipcMain.handle(
    IpcChannel.MCP_SAVE,
    (_e, server) => saveMcpServer({
      id: server.id,
      name: server.name,
      description: server.description,
      command: server.command,
      args: server.args,
      env: server.env,
      enabled: server.enabled,
      builtin: server.builtin
    })
  );
  import_electron5.ipcMain.handle(IpcChannel.MCP_REMOVE, (_e, id) => removeMcpServer(id));
  import_electron5.ipcMain.handle(IpcChannel.MCP_TOGGLE, (_e, id, enabled) => toggleMcpServer(id, enabled));
  import_electron5.ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_OPEN, (_e, url, appId) => {
    console.log(`[IPC] EXTERNAL_BROWSER_OPEN: url="${url}", appId="${appId}"`);
    return openExternalBrowser(url, appId);
  });
  import_electron5.ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_CLOSE, (_e, appId) => closeExternalBrowser(appId));
  import_electron5.ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_NAVIGATE, (_e, url, appId) => navigateExternalBrowser(url, appId));
  import_electron5.ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_FOCUS, (_e, appId) => focusExternalBrowser(appId));
  import_electron5.ipcMain.on(IpcChannel.BROWSER_MODE, () => {
  });
}

// src/main/main.ts
fixPath();
var isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
function isExternalUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
function createWindow() {
  const win = new import_electron6.BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#0b0c0e",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 20, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: import_node_path5.default.join(__dirname, "../dist-preload/index.cjs")
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      win.webContents.send(IpcChannel.OPEN_URL, url);
    }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isDev && url.startsWith(process.env.VITE_DEV_SERVER_URL)) return;
    if (isExternalUrl(url)) {
      event.preventDefault();
      win.webContents.send(IpcChannel.OPEN_URL, url);
    }
  });
  win.webContents.on("context-menu", (_event, params) => {
    const menu = new import_electron6.Menu();
    if (params.selectionText) {
      menu.append(new import_electron6.MenuItem({ label: "\u590D\u5236", role: "copy" }));
    }
    menu.append(new import_electron6.MenuItem({ label: "\u5168\u9009", role: "selectAll" }));
    if (params.isEditable) {
      menu.append(new import_electron6.MenuItem({ type: "separator" }));
      menu.append(new import_electron6.MenuItem({ label: "\u7C98\u8D34", role: "paste" }));
      menu.append(new import_electron6.MenuItem({ label: "\u526A\u5207", role: "cut" }));
      menu.append(new import_electron6.MenuItem({ label: "\u64A4\u9500", role: "undo" }));
      menu.append(new import_electron6.MenuItem({ label: "\u91CD\u505A", role: "redo" }));
    }
    menu.popup();
  });
  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "bottom" });
  } else {
    win.loadFile(import_node_path5.default.join(__dirname, "../dist/index.html"));
  }
}
import_electron6.app.whenReady().then(() => {
  logInfo("app", `Taco started (${isDev ? "dev" : "prod"})`, {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    logDir: getLogDir()
  });
  createWindow();
  registerIpcHandlers();
  import_electron6.app.on("activate", () => {
    if (import_electron6.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
import_electron6.app.on("window-all-closed", () => {
  shutdownAllMcp();
  if (process.platform !== "darwin") {
    import_electron6.app.quit();
  }
});
