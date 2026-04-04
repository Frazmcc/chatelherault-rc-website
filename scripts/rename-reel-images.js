const fs = require('fs')
const path = require('path')

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif'])
const DEFAULT_PREFIX = 'chatelherault-reel'
const DEFAULT_SORT_THRESHOLD = 50000
const DEFAULT_DRY_RUN_PREVIEW_LIMIT = 200
const MANIFEST_FILE_NAME = 'reel-manifest.json'

function parseArgs(argv) {
  const args = argv.slice(2)
  const options = {
    dryRun: false,
    sourceDir: path.resolve(process.cwd(), 'assets/reel/incoming'),
    destinationDir: path.resolve(process.cwd(), 'assets/reel/optimized'),
    prefix: DEFAULT_PREFIX,
    stateFile: path.resolve(process.cwd(), 'assets/reel/.rename-state.json'),
    noSort: false,
    sortThreshold: DEFAULT_SORT_THRESHOLD,
    dryRunPreviewLimit: DEFAULT_DRY_RUN_PREVIEW_LIMIT,
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]

    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (arg === '--source' && args[i + 1]) {
      options.sourceDir = path.resolve(process.cwd(), args[i + 1])
      i += 1
      continue
    }

    if (arg === '--dest' && args[i + 1]) {
      options.destinationDir = path.resolve(process.cwd(), args[i + 1])
      i += 1
      continue
    }

    if (arg === '--prefix' && args[i + 1]) {
      options.prefix = String(args[i + 1]).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
      i += 1
      continue
    }

    if (arg === '--state' && args[i + 1]) {
      options.stateFile = path.resolve(process.cwd(), args[i + 1])
      i += 1
      continue
    }

    if (arg === '--no-sort') {
      options.noSort = true
      continue
    }

    if (arg === '--sort-threshold' && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1], 10)
      if (Number.isInteger(parsed) && parsed >= 0) {
        options.sortThreshold = parsed
      }
      i += 1
      continue
    }

    if (arg === '--preview-limit' && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1], 10)
      if (Number.isInteger(parsed) && parsed >= 0) {
        options.dryRunPreviewLimit = parsed
      }
      i += 1
      continue
    }
  }

  return options
}

function collectImages(sourceDir, noSort, sortThreshold) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source folder does not exist: ${sourceDir}`)
  }

  const files = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()))

  if (noSort) {
    return files
  }

  if (sortThreshold > 0 && files.length > sortThreshold) {
    console.warn(
      `Skipping in-memory sort for ${files.length} files (threshold: ${sortThreshold}). Use --sort-threshold to override.`
    )
    return files
  }

  return files.sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }))
}

function getStateLastSequence(stateFile, prefix) {
  if (!fs.existsSync(stateFile)) {
    return 0
  }

  try {
    const raw = fs.readFileSync(stateFile, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.prefix !== prefix) {
      return 0
    }

    const sequence = Number(parsed.lastSequence)
    if (!Number.isInteger(sequence) || sequence < 0) {
      return 0
    }

    return sequence
  } catch {
    return 0
  }
}

function getDestinationLastSequence(destinationDir, prefix) {
  if (!fs.existsSync(destinationDir)) {
    return 0
  }

  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sequencePattern = new RegExp(`^${escapedPrefix}-(\\d+)\\.[^.]+$`, 'i')
  let max = 0

  const entries = fs.readdirSync(destinationDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }

    const match = entry.name.match(sequencePattern)
    if (!match) {
      continue
    }

    const value = Number(match[1])
    if (Number.isInteger(value) && value > max) {
      max = value
    }
  }

  return max
}

function ensureDirectoryExists(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function moveFile(sourcePath, destinationPath) {
  try {
    fs.renameSync(sourcePath, destinationPath)
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      fs.copyFileSync(sourcePath, destinationPath)
      fs.unlinkSync(sourcePath)
      return
    }

    throw error
  }
}

function saveState(stateFile, prefix, lastSequence) {
  const payload = {
    prefix,
    lastSequence,
    updatedAt: new Date().toISOString(),
  }

  ensureDirectoryExists(path.dirname(stateFile))
  fs.writeFileSync(stateFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function saveManifest(destinationDir, prefix) {
  if (!fs.existsSync(destinationDir)) {
    return
  }

  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const filePattern = new RegExp(`^${escapedPrefix}-(\\d+)\\.([^.]+)$`, 'i')

  const items = fs
    .readdirSync(destinationDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .map((name) => {
      const match = name.match(filePattern)
      if (!match) {
        return null
      }

      return {
        sequence: Number(match[1]),
        src: `/assets/reel/optimized/${name}`,
      }
    })
    .filter((entry) => entry && Number.isInteger(entry.sequence) && entry.sequence > 0)
    .sort((a, b) => a.sequence - b.sequence || a.src.localeCompare(b.src))

  const payload = {
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
  }

  fs.writeFileSync(path.join(destinationDir, MANIFEST_FILE_NAME), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function buildTargetName(prefix, sourceName, startSequence, index) {
  const ext = path.extname(sourceName).toLowerCase()
  const sequence = String(startSequence + index + 1).padStart(4, '0')
  return `${prefix}-${sequence}${ext}`
}

function runRename(sourceDir, destinationDir, stateFile, prefix, startSequence, files, dryRun, dryRunPreviewLimit) {
  if (!files.length) {
    saveManifest(destinationDir, prefix)
    console.log('No supported image files found to rename.')
    return
  }

  ensureDirectoryExists(destinationDir)

  const seenTargets = new Set()

  for (let index = 0; index < files.length; index += 1) {
    const sourceName = files[index]
    const targetName = buildTargetName(prefix, sourceName, startSequence, index)

    if (seenTargets.has(targetName)) {
      throw new Error(`Duplicate target filename generated: ${targetName}`)
    }

    seenTargets.add(targetName)

    if (fs.existsSync(path.join(destinationDir, targetName))) {
      throw new Error(`Target filename collision detected for: ${targetName}`)
    }
  }

  console.log(`Found ${files.length} image(s). Starting at sequence ${String(startSequence + 1).padStart(4, '0')}.`)

  const cappedPreview = Number.isInteger(dryRunPreviewLimit) ? Math.max(dryRunPreviewLimit, 0) : 0
  const previewCount = dryRun ? Math.min(files.length, cappedPreview) : files.length

  for (let index = 0; index < previewCount; index += 1) {
    const sourceName = files[index]
    const targetName = buildTargetName(prefix, sourceName, startSequence, index)
    const sourcePath = path.join(sourceDir, sourceName)
    const targetPath = path.join(destinationDir, targetName)
    console.log(`${dryRun ? '[dry-run] ' : ''}${sourcePath} -> ${targetPath}`)
  }

  if (dryRun && previewCount < files.length) {
    const omitted = files.length - previewCount
    console.log(`[dry-run] ... ${omitted} additional rename(s) omitted. Use --preview-limit to increase output.`)
  }

  if (dryRun) {
    return
  }

  for (let index = 0; index < files.length; index += 1) {
    const sourceName = files[index]
    const targetName = buildTargetName(prefix, sourceName, startSequence, index)
    const sourcePath = path.join(sourceDir, sourceName)
    const targetPath = path.join(destinationDir, targetName)
    moveFile(sourcePath, targetPath)
  }

  saveState(stateFile, prefix, startSequence + files.length)
  saveManifest(destinationDir, prefix)

  console.log(`Move complete. Last sequence is now ${String(startSequence + files.length).padStart(4, '0')}.`)
}

function main() {
  const options = parseArgs(process.argv)
  const files = collectImages(options.sourceDir, options.noSort, options.sortThreshold)
  const destinationLastSequence = getDestinationLastSequence(options.destinationDir, options.prefix)
  const stateLastSequence = getStateLastSequence(options.stateFile, options.prefix)
  const startSequence = Math.max(destinationLastSequence, stateLastSequence)
  runRename(
    options.sourceDir,
    options.destinationDir,
    options.stateFile,
    options.prefix,
    startSequence,
    files,
    options.dryRun,
    options.dryRunPreviewLimit
  )
}

try {
  main()
} catch (error) {
  console.error(error.message || String(error))
  process.exitCode = 1
}
