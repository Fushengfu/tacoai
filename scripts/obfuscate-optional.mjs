import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const enabled = String(process.env.TACO_OBFUSCATE || '').trim() === '1'
if (!enabled) {
  console.log('[obfuscate] skipped (set TACO_OBFUSCATE=1 to enable)')
  process.exit(0)
}

let JavaScriptObfuscator
try {
  const mod = await import('javascript-obfuscator')
  JavaScriptObfuscator = mod.default ?? mod
} catch {
  console.warn('[obfuscate] package "javascript-obfuscator" not installed, skipping')
  process.exit(0)
}

const root = process.cwd()
const targets = [
  path.join(root, 'dist-main', 'main.cjs'),
  path.join(root, 'dist-preload', 'index.cjs'),
]

async function collectRendererBundles() {
  const assetsDir = path.join(root, 'dist', 'assets')
  try {
    const files = await fs.readdir(assetsDir)
    for (const file of files) {
      if (file.endsWith('.js')) targets.push(path.join(assetsDir, file))
    }
  } catch {
    // ignore missing assets folder
  }
}

function obfuscateCode(sourceCode) {
  return JavaScriptObfuscator.obfuscate(sourceCode, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.55,
    deadCodeInjection: false,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 12,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.9,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
  }).getObfuscatedCode()
}

async function obfuscateFile(filePath) {
  try {
    const source = await fs.readFile(filePath, 'utf8')
    const output = obfuscateCode(source)
    await fs.writeFile(filePath, output, 'utf8')
    console.log(`[obfuscate] done: ${path.relative(root, filePath)}`)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[obfuscate] failed: ${path.relative(root, filePath)} (${message})`)
    return false
  }
}

await collectRendererBundles()
if (targets.length === 0) {
  console.warn('[obfuscate] no targets found')
  process.exit(0)
}

console.log(`[obfuscate] enabled, total targets=${targets.length}`)
for (const filePath of targets) {
  await obfuscateFile(filePath)
}
