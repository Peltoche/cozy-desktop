/** Test scenario helpers
 *
 * @module test/support/helpers/scenarios
 * @flow
 */

const Promise = require('bluebird')
const fse = require('fs-extra')
const glob = require('glob')
const _ = require('lodash')
const path = require('path')

const stater = require('../../../core/local/stater')
const timestamp = require('../../../core/utils/timestamp')

const { cozy } = require('./cozy')
const Builders = require('../builders')

/*::
import type { Scenario, ScenarioInit, FSAction } from '../../scenarios'
import type { Metadata } from '../../../core/metadata'
import type { Pouch } from '../../../core/pouch'
import type { Stats } from '../../../core/local/stater'
*/

const debug = (...args) =>
  // eslint-disable-next-line no-console
  process.env.TESTDEBUG ? console.log(...args) : () => {}

const scenariosDir = path.resolve(__dirname, '../../scenarios')

const scenarioByPath = (module.exports.scenarioByPath = (
  scenarioPath /*: string */
) => {
  // $FlowFixMe
  const scenario = require(scenarioPath)
  scenario.name = path
    .dirname(path.normalize(scenarioPath))
    .replace(scenariosDir + path.sep, '')
    .replace(/\\/g, '/')
  scenario.path = scenarioPath

  if (
    process.platform === 'win32' &&
    scenario.expected &&
    scenario.expected.prepCalls
  ) {
    for (let prepCall of scenario.expected.prepCalls) {
      if (prepCall.src) {
        prepCall.src = prepCall.src.split('/').join('\\')
        // @TODO why is src in maj
      }
      if (prepCall.path) prepCall.path = prepCall.path.split('/').join('\\')
      if (prepCall.dst) prepCall.dst = prepCall.dst.split('/').join('\\')
    }
  }

  scenario.useCaptures =
    scenario.useCaptures != null ? scenario.useCaptures : true

  return scenario
})

const statsFixer = event => {
  if (event.stats) {
    event.stats = _.defaultsDeep(
      {
        atime: new Date(event.stats.atime),
        mtime: new Date(event.stats.mtime),
        ctime: new Date(event.stats.ctime),
        birthtime: new Date(event.stats.birthtime)
      },
      event.stats
    )
  }
}

const windowsPathFixer = (filename, event) => {
  if (filename.indexOf('win32') !== -1 && process.platform !== 'win32') {
    if (event.path) event.path = event.path.replace(/\\/g, '/')
    if (event.oldPath) event.oldPath = event.oldPath.replace(/\\/g, '/')
  }
  if (filename.indexOf('win32') === -1 && process.platform === 'win32') {
    if (event.path) event.path = event.path.replace(/\//g, '\\')
    if (event.oldPath) event.oldPath = event.oldPath.replace(/\//g, '\\')
  }
}

// TODO: Refactor to function
module.exports.scenarios = glob
  .sync(path.join(scenariosDir, '**/scenario.js*'), {})
  .map(scenarioByPath)

if (module.exports.scenarios.length === 0) {
  throw new Error(
    `No scenario found! Please check scenariosDir: ${scenariosDir}`
  )
}

const disabledScenario = scenario =>
  typeof scenario.disabled === 'string' && scenario.disabled

/**
 * For historical reasons, `disabledScenarioTest()` may receive test names
 * with file extension. Although it may be useless in many cases, stripping
 * them will make sure code always works.
 */
const disabledScenarioTest = (
  scenario /*: Scenario */,
  testName /*: string */
) =>
  disabledScenario(scenario) ||
  _.get(scenario, ['disabled', testName.replace(path.extname(testName), '')])

module.exports.disabledScenarioTest = disabledScenarioTest

module.exports.loadFSEventFiles = (
  scenario /*: Scenario & { path: string } */
) => {
  const eventFiles = glob.sync(
    path.join(path.dirname(scenario.path), 'local', '*.json*')
  )
  const disabledEventsFile = name => {
    if (process.platform === 'win32' && name.indexOf('win32') === -1) {
      return 'darwin/linux test'
    } else if (
      process.env.COZY_DESKTOP_FS === 'APFS' &&
      name.indexOf('hfs+') !== -1
    ) {
      return 'HFS+ test'
    } else if (
      process.env.COZY_DESKTOP_FS === 'HFS+' &&
      name.indexOf('apfs') !== -1
    ) {
      return 'APFS test'
    } else {
      return disabledScenarioTest(scenario, `local/${name}`)
    }
  }
  return eventFiles.map(f => {
    const name = path.basename(f)
    const disabled = disabledScenario(scenario) || disabledEventsFile(name)
    const events = fse.readJsonSync(f).map(e => {
      statsFixer(e)
      windowsPathFixer(name, e)
      return e
    })

    return { name, events, disabled }
  })
}

module.exports.loadAtomCaptures = (
  scenario /*: Scenario & { path: string } */
) => {
  const eventFiles = glob.sync(
    path.join(path.dirname(scenario.path), 'atom', '*.json*')
  )
  const disabledEventsFile = name => {
    if (process.platform === 'win32' && name.indexOf('win32') === -1) {
      return 'linux test'
    } else if (process.platform === 'linux' && name.indexOf('win32') >= 0) {
      return 'win32 test'
    } else {
      return disabledScenarioTest(scenario, `atom/${name}`)
    }
  }
  return eventFiles.map(f => {
    const name = path.basename(f)
    const disabled = disabledScenario(scenario) || disabledEventsFile(name)
    const batches = fse.readJsonSync(f).map(batch =>
      batch.map(event => {
        statsFixer(event)
        windowsPathFixer(name, event)
        return event
      })
    )

    return { name, batches, disabled }
  })
}

module.exports.loadRemoteChangesFiles = (
  scenario /*: Scenario & { path: string } */
) => {
  const pattern = path.join(path.dirname(scenario.path), 'remote', '*.json*')

  return glob.sync(pattern).map(f => {
    const name = path.basename(f)
    const disabled = disabledScenarioTest(scenario, 'remote')
    const changes = fse.readJsonSync(f)
    return { name, disabled, changes }
  })
}

const getInoAndFileId = async ({
  path,
  fakeIno,
  trashed,
  useRealInodes
}) /*: Promise<Stats> */ => {
  if (trashed || !useRealInodes) {
    return { ino: fakeIno }
  } else {
    return stater.stat(path)
  }
}

const merge = async (srcPath, dstPath) => {
  let srcStats, dstStats
  try {
    srcStats = await fse.stat(srcPath)
    dstStats = await fse.stat(dstPath)
  } catch (err) {
    debug('stat', err)
  }

  if (!dstStats || dstStats.isFile()) {
    await fse.rename(srcPath, dstPath)
  } else if (srcStats && srcStats.isFile()) {
    await fse.rmdir(dstPath, { recursive: true })
    await fse.rename(srcPath, dstPath)
  } else {
    for (const entry of await fse.readdir(srcPath)) {
      await merge(path.join(srcPath, entry), path.join(dstPath, entry))
    }
  }
  try {
    await fse.rmdir(srcPath)
  } catch (err) {
    debug('rmdir', err)
  }
}

const isOutside = relpath => relpath.startsWith('../outside')

module.exports.init = async (
  scenario /*: { init: ScenarioInit } */,
  pouch /*: Pouch */,
  abspath /*: (string) => string */,
  useRealInodes /*: boolean */ = false
) => {
  debug('[init]')
  const builders = new Builders({ cozy, pouch })
  const remoteDocsToTrash = []

  if (scenario.init) {
    for (const {
      path: relpath,
      ino: fakeIno,
      trashed,
      content = 'foo'
    } of scenario.init) {
      debug(relpath)

      const localPath = path.normalize(_.trimEnd(relpath, '/'))
      if (!trashed) {
        if (relpath.endsWith('/')) {
          debug(`- create local dir: ${localPath}`)
          await fse.ensureDir(abspath(localPath))
        } else {
          debug(`- create local file: ${localPath}`)
          await fse.outputFile(abspath(localPath), content)
        }
      }

      if (isOutside(relpath)) continue

      const remoteParentPath = path.posix.join('/', path.posix.dirname(relpath))
      debug(`- retrieve remote parent: ${remoteParentPath}`)
      const remoteParent = await cozy.files.statByPath(remoteParentPath)
      if (!remoteParent) {
        debug(`Could not retrieve remote parent: ${remoteParentPath}`)
        return
      }

      const remoteName = path.posix.basename(relpath)
      const remotePath = path.posix.join(
        _.get(remoteParent, 'attributes.path', ''),
        remoteName
      )
      const updatedAt = new Date('2011-04-11T10:20:30Z').toISOString()

      if (relpath.endsWith('/')) {
        debug(
          `- create${trashed ? ' and trash' : ''} remote dir: ${remotePath}`
        )
        const remoteDir = await builders
          .remoteDir()
          .name(remoteName)
          .inDir({
            _id: remoteParent._id,
            path: remoteParent.attributes.path
          })
          .createdAt(...timestamp.spread(updatedAt))
          .updatedAt(...timestamp.spread(updatedAt))
          .create()

        if (trashed) {
          remoteDocsToTrash.push(remoteDir)
        } else {
          const stats = await getInoAndFileId({
            path: abspath(localPath),
            fakeIno,
            trashed,
            useRealInodes
          })
          const doc = builders
            .metadir()
            .fromRemote(remoteDir)
            .upToDate()
            .build()
          stater.assignInoAndFileId(doc, stats)

          debug(`- create dir metadata: ${doc._id}`)
          await pouch.put(doc)
        }
      } else {
        debug(
          `- create${trashed ? ' and trash' : ''} remote file: ${remotePath}`
        )
        const remoteFile = await builders
          .remoteFile()
          .name(remoteName)
          .inDir({
            _id: remoteParent._id,
            path: remoteParent.attributes.path
          })
          .data(content)
          .executable(false)
          .createdAt(...timestamp.spread(updatedAt))
          .updatedAt(...timestamp.spread(updatedAt))
          .create()

        if (trashed) {
          remoteDocsToTrash.push(remoteFile)
        } else {
          const stats = await getInoAndFileId({
            path: abspath(localPath),
            fakeIno,
            trashed,
            useRealInodes
          })
          const doc = builders
            .metafile()
            .fromRemote(remoteFile)
            .upToDate()
            .build()
          stater.assignInoAndFileId(doc, stats)
          stater.assignInoAndFileId(doc.local, stats)

          debug(`- create file metadata: ${doc._id}`)
          await pouch.put(doc)
        }
      } // if relpath ...
    } // for (... of scenario.init)
  }

  for (const remoteDoc of remoteDocsToTrash) {
    debug(`- trashing remote ${remoteDoc.type}: ${remoteDoc.path}`)
    try {
      await cozy.files.trashById(remoteDoc._id)
    } catch (err) {
      if (err.status === 400) continue
      throw err
    }
  }
}

module.exports.runActions = (
  scenario /*: { actions: Array<FSAction>, name?: string } */,
  abspath /*: (string) => string */,
  opts /*: {skipWait?: true} */ = {}
) => {
  debug('[actions]')
  return Promise.each(scenario.actions, action => {
    switch (action.type) {
      case 'mkdir':
        debug('- mkdir', action.path)
        return fse.ensureDir(abspath(action.path))

      case 'create_file':
        debug('- create_file', action.path)
        return fse.outputFile(
          abspath(action.path),
          action.content || 'whatever'
        )

      case 'update_file':
        debug('- update_file', action.path)
        return fse.writeFile(abspath(action.path), action.content)

      case 'trash':
        debug('- trash', action.path)
        return fse.remove(abspath(action.path))

      case 'delete':
        debug('- delete', action.path)
        return fse.remove(abspath(action.path))

      case 'mv':
        debug('- mv', action.force ? 'force' : '', action.src, action.dst)
        if (action.merge) {
          return merge(abspath(action.src), abspath(action.dst))
        } else if (action.force) {
          return fse.move(abspath(action.src), abspath(action.dst), {
            overwrite: true
          })
        } else {
          return fse.rename(abspath(action.src), abspath(action.dst))
        }

      case 'wait':
        if (opts.skipWait) return Promise.resolve()
        debug('- wait', action.ms)
        return Promise.delay(action.ms)

      default:
        return Promise.reject(
          new Error(
            `Unknown action ${action.type} ${
              scenario.name ? 'for scenario' + scenario.name : ''
            }`
          )
        )
    }
  })
}
