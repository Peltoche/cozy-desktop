/* @flow */

import clone from 'lodash.clone'
import path from 'path'

import Local from './local'
import logger from './logger'
import { isUpToDate, markSide, sameBinary, sameFile, sameFolder } from './metadata'
import Pouch from './pouch'
import Remote from './remote'
import { otherSide } from './side'
import * as fsutils from './utils/fs'

import type { SideName, Metadata } from './metadata'

const log = logger({
  component: 'Merge'
})

// When the local filesystem or the remote cozy detects a change, it calls this
// class to inform it (via Prep). This class will check how to operate this
// change against the data in pouchdb and then will update pouchdb. It avoids a
// lot of bogus data in pouchdb, like file created in the folder that doesn't
// exist.
//
// The documents in PouchDB have similar informations of those in CouchDB, but
// are not structured in the same way. In particular, the _id are uuid in CouchDB
// and the path to the file/folder (in a normalized form) in PouchDB.
//
// Conflicts can happen when we try to write one document for a path when
// another document already exists for the same path. We don't try to be smart
// and the rename one the two documents with a -conflict suffix. And even that
// isn't simple to implement. When the document is renamed, it fires some events
// that are not in the normal flow (rename instead of add, bogus delete) and we
// need to redirect them.
class Merge {
  pouch: Pouch
  local: Local
  remote: Remote

  constructor (pouch: Pouch) {
    this.pouch = pouch
    // $FlowFixMe
    this.local = this.remote = null
  }

  /* Helpers */

  // Be sure that the tree structure for the given path exists
  async ensureParentExistAsync (side: SideName, doc: *) {
    let parentId = path.dirname(doc._id)
    if (parentId === '.') { return }

    try {
      let folder = await this.pouch.db.get(parentId)
      if (folder) { return }
    } catch (err) {
      if (err.status !== 404) { log.warn(err) }
    }

    let parentDoc = {
      _id: parentId,
      path: path.dirname(doc.path),
      docType: 'folder',
      updated_at: new Date()
    }

    try {
      await this.ensureParentExistAsync(side, parentDoc)
    } catch (err) {
      throw err
    }

    return this.putFolderAsync(side, parentDoc)
  }

  // Resolve a conflict by renaming a file/folder
  // A suffix composed of -conflict- and the date is added to the path.
  async resolveConflictAsync (side: SideName, doc: Metadata) {
    let dst = clone(doc)
    let date = fsutils.validName(new Date().toISOString())
    let ext = path.extname(doc.path)
    let dir = path.dirname(doc.path)
    let base = path.basename(doc.path, ext)
    // 180 is an arbitrary limit to avoid having files with too long names
    if (base.length > 180) {
      base = base.slice(0, 180)
    }
    dst.path = `${path.join(dir, base)}-conflict-${date}${ext}`
    try {
      // $FlowFixMe
      await this[side].resolveConflictAsync(dst, doc)
    } catch (err) {
      throw err
    }
    return dst
  }

  /* Actions */

  // Add a file, if it doesn't already exist,
  // and create the tree structure if needed
  async addFileAsync (side: SideName, doc: Metadata) {
    let file
    try {
      file = await this.pouch.db.get(doc._id)
    } catch (err) {
      if (err.status !== 404) { log.warn(err) }
    }
    markSide(side, doc, file)
    if (file && file.docType === 'folder') {
      return this.resolveConflictAsync(side, doc)
    }
    if (file && sameBinary(file, doc)) {
      doc._rev = file._rev
      if (doc.size == null) { doc.size = file.size }
      if (doc.class == null) { doc.class = file.class }
      if (doc.mime == null) { doc.mime = file.mime }
      if (doc.tags == null) { doc.tags = file.tags || [] }
      if (doc.remote == null) { doc.remote = file.remote }
      if (sameFile(file, doc)) {
        return null
      } else {
        return this.pouch.put(doc)
      }
    }
    if (file) {
      if ((side === 'local') && (file.sides.local != null)) {
        return this.resolveInitialAddAsync(side, doc, file)
      } else {
        return this.resolveConflictAsync(side, doc)
      }
    }
    if (doc.tags == null) { doc.tags = [] }
    await this.ensureParentExistAsync(side, doc)
    return this.pouch.put(doc)
  }

  // When a file is modified when cozy-desktop is not running,
  // it is detected as a new file when cozy-desktop is started.
  async resolveInitialAddAsync (side: SideName, doc: Metadata, file: Metadata) {
    if (!file.sides.remote) {
      // The file was updated on local before being pushed to remote
      return this.updateFileAsync(side, doc)
    } else if (file.sides.remote === file.sides.local) {
      // The file was updated on local after being synched to remote
      return this.updateFileAsync(side, doc)
    } else {
      // The file was updated on remote and maybe in local too
      let shortRev = file.sides.local
      try {
        const prev = await this.pouch.getPreviousRevAsync(doc._id, shortRev)
        if (prev.md5sum === doc.md5sum) {
          // The file was only updated on remote
          return null
        }
      } catch (_) {}
      // It's safer to handle it as a conflict
      if (doc.remote == null) { doc.remote = file.remote }
      return this.resolveConflictAsync('remote', doc)
    }
  }

  // Update a file, when its metadata or its content has changed
  async updateFileAsync (side: SideName, doc: Metadata) {
    let file
    try {
      file = await this.pouch.db.get(doc._id)
    } catch (err) {
      if (err.status !== 404) { log.warn(err) }
    }
    markSide(side, doc, file)
    if (file && file.docType === 'folder') {
      throw new Error("Can't resolve this conflict!")
    }
    if (file) {
      doc._rev = file._rev
      if (doc.tags == null) { doc.tags = file.tags || [] }
      if (doc.remote == null) { doc.remote = file.remote }
      if (sameBinary(file, doc)) {
        if (doc.size == null) { doc.size = file.size }
        if (doc.class == null) { doc.class = file.class }
        if (doc.mime == null) { doc.mime = file.mime }
      } else if (!isUpToDate(side, file)) {
        return this.resolveConflictAsync(side, doc)
      }
      if (sameFile(file, doc)) {
        log.info({doc}, 'up to date')
        return null
      } else {
        return this.pouch.put(doc)
      }
    }
    if (doc.tags == null) { doc.tags = [] }
    await this.ensureParentExistAsync(side, doc)
    return this.pouch.put(doc)
  }

  // Create or update a folder
  async putFolderAsync (side: SideName, doc: *) {
    let folder
    try {
      folder = await this.pouch.db.get(doc._id)
    } catch (err) {
      if (err.status !== 404) { log.warn(err) }
    }
    markSide(side, doc, folder)
    if (folder && folder.docType === 'file') {
      return this.resolveConflictAsync(side, doc)
    }
    if (folder) {
      doc._rev = folder._rev
      if (doc.tags == null) { doc.tags = folder.tags || [] }
      if (doc.remote == null) { doc.remote = folder.remote }
      if (sameFolder(folder, doc)) {
        log.info({doc}, 'up to date')
        return null
      } else {
        return this.pouch.put(doc)
      }
    }
    if (doc.tags == null) { doc.tags = [] }
    await this.ensureParentExistAsync(side, doc)
    return this.pouch.put(doc)
  }

  // Rename or move a file
  async moveFileAsync (side: SideName, doc: Metadata, was: Metadata) {
    if (was.sides && was.sides[side]) {
      let file
      try {
        file = await this.pouch.db.get(doc._id)
      } catch (err) {
        if (err.status !== 404) { log.warn(err) }
      }
      markSide(side, doc, file)
      markSide(side, was, was)
      if (doc.size == null) { doc.size = was.size }
      if (doc.class == null) { doc.class = was.class }
      if (doc.mime == null) { doc.mime = was.mime }
      if (doc.tags == null) { doc.tags = was.tags || [] }
      delete doc.trashed
      was.moveTo = doc._id
      was._deleted = true
      delete was.errors
      if (file && sameFile(file, doc)) {
        return null
      } else if (file) {
        const dst = await this.resolveConflictAsync(side, doc)
        was.moveTo = dst._id
        dst.sides = {}
        dst.sides[side] = 1
        return this.pouch.bulkDocs([was, dst])
      } else {
        await this.ensureParentExistAsync(side, doc)
        return this.pouch.bulkDocs([was, doc])
      }
    } else { // It can happen after a conflict
      return this.addFileAsync(side, doc)
    }
  }

  // Rename or move a folder (and every file and folder inside it)
  async moveFolderAsync (side: SideName, doc: Metadata, was: Metadata) {
    if (was.sides && was.sides[side]) {
      let folder
      try {
        folder = await this.pouch.db.get(doc._id)
      } catch (err) {
        if (err.status !== 404) { log.warn(err) }
      }
      markSide(side, doc, folder)
      markSide(side, was, was)
      if (doc.tags == null) { doc.tags = was.tags || [] }
      delete doc.trashed
      if (folder) {
        const dst = await this.resolveConflictAsync(side, doc)
        dst.sides = {}
        dst.sides[side] = 1
        return this.moveFolderRecursivelyAsync(side, dst, was)
      } else {
        await this.ensureParentExistAsync(side, doc)
        return this.moveFolderRecursivelyAsync(side, doc, was)
      }
    } else { // It can happen after a conflict
      return this.putFolderAsync(side, doc)
    }
  }

  // Move a folder and all the things inside it
  async moveFolderRecursivelyAsync (side: SideName, folder: Metadata, was: Metadata) {
    let docs
    try {
      docs = await this.pouch.byRecursivePathAsync(was._id)
    } catch (err) {
      throw err
    }
    was._deleted = true
    was.moveTo = folder._id
    let bulk = [was, folder]
    for (let doc of Array.from(docs)) {
      // TODO: Extract metadata copy logic
      delete doc.trashed
      let src = clone(doc)
      src._deleted = true
      // moveTo is used for comparison. It's safer to take _id
      // than path for this case, as explained in doc/design.md
      src.moveTo = doc._id.replace(was._id, folder._id)
      delete src.errors
      bulk.push(src)
      let dst = clone(doc)
      markSide(side, dst, src)
      dst._id = src.moveTo
      dst.path = doc.path.replace(was.path, folder.path)
      delete dst._rev
      delete dst.errors
      bulk.push(dst)
    }
    return this.pouch.bulkDocs(bulk)
  }

  async restoreFileAsync (side: SideName, was: Metadata, doc: Metadata): Promise<*> {
    // TODO we can probably do something smarter for conflicts and avoiding to
    // transfer again the file
    try {
      await this.deleteFileAsync(side, was)
    } catch (err) {
      log.warn(err)
    }
    return this.updateFileAsync(side, doc)
  }

  async restoreFolderAsync (side: SideName, was: Metadata, doc: Metadata): Promise<*> {
    // TODO we can probably do something smarter for conflicts
    try {
      await this.deleteFolderAsync(side, was)
    } catch (err) {
      log.warn(err)
    }
    return this.putFolderAsync(side, doc)
  }

  async trashFileAsync (side: SideName, was: *, doc: *): Promise<void> {
    let oldMetadata
    try {
      oldMetadata = await this.pouch.db.get(was._id)
    } catch (err) {
      if (err.status === 404) {
        log.debug(`${doc._id}: Nothing to trash`)
        return
      }
      throw err
    }
    if (doc.docType !== oldMetadata.docType) {
      await this.resolveConflictAsync(side, doc)
      return
    }
    delete oldMetadata.errors
    const newMetadata = clone(oldMetadata)
    markSide(side, newMetadata, oldMetadata)
    newMetadata.trashed = true
    if (oldMetadata.sides && oldMetadata.sides[side]) {
      markSide(side, oldMetadata, oldMetadata)
      oldMetadata._deleted = true
      try {
        await this.pouch.put(oldMetadata)
      } catch (err) {
        log.warn(err)
      }
    }
    return this.pouch.put(newMetadata)
  }

  async trashFolderAsync (side: SideName, was: *, doc: *): Promise<void> {
    // Don't trash a folder if the other side has added a new file in it (or updated one)
    let children = await this.pouch.byRecursivePathAsync(was._id)
    children = children.reverse()
    for (let child of Array.from(children)) {
      if (child.docType === 'file' && !isUpToDate(side, child)) {
        delete was.errors
        delete was.sides[side]
        return this.pouch.put(was)
      }
    }
    // Remove in pouchdb the sub-folders
    for (let child of Array.from(children)) {
      if (child.docType === 'folder') {
        try {
          child._deleted = true
          await this.pouch.put(child)
        } catch (err) {
          log.warn(err)
        }
      }
    }
    return this.trashFileAsync(side, was, doc)
  }

  // Remove a file from PouchDB
  //
  // As the watchers often detect the deletion of a folder before the deletion
  // of the files inside it, deleteFile can be called for a file that has
  // already been removed. This is not considerated as an error.
  async deleteFileAsync (side: SideName, doc: Metadata) {
    let file
    try {
      file = await this.pouch.db.get(doc._id)
    } catch (err) {
      if (err.status === 404) {
        return null
      } else {
        throw err
      }
    }
    if (file.sides && file.sides[side]) {
      markSide(side, file, file)
      file._deleted = true
      delete file.errors
      return this.pouch.put(file)
    } else { // It can happen after a conflict
      return null
    }
  }

  // Remove a folder
  //
  // When a folder is removed in PouchDB, we also remove the files and folders
  // inside it to ensure consistency. The watchers often detects the deletion
  // of a nested folder after the deletion of its parent. In this case, the
  // call to deleteFolder for the child is considered as successful, even if
  // the folder is missing in pouchdb (error 404).
  async deleteFolderAsync (side: SideName, doc: Metadata) {
    let folder
    try {
      folder = await this.pouch.db.get(doc._id)
    } catch (err) {
      if (err.status === 404) {
        return null
      } else {
        throw err
      }
    }
    if (folder.sides && folder.sides[side]) {
      return this.deleteFolderRecursivelyAsync(side, folder)
    } else { // It can happen after a conflict
      return null
    }
  }

  // Remove a folder and every thing inside it
  async deleteFolderRecursivelyAsync (side: SideName, folder: Metadata) {
    let docs = await this.pouch.byRecursivePathAsync(folder._id)
    // In the changes feed, nested subfolder must be deleted
    // before their parents, hence the reverse order.
    docs = docs.reverse()
    docs.push(folder)
    const toPreserve = new Set()
    for (let doc of Array.from(docs)) {
      if (toPreserve.has(doc.path) || (doc.sides && !isUpToDate(side, doc))) {
        log.warn(`${doc.path}: cannot be deleted with ${folder.path}: ` +
          `${doc.docType} was modified on the ${otherSide(side)} side`)
        log.info(`${doc.path}: Dissociating from remote...`)
        delete doc.remote
        if (doc.sides) delete doc.sides.remote
        toPreserve.add(path.dirname(doc.path))
      } else {
        markSide(side, doc, doc)
        doc._deleted = true
        delete doc.errors
      }
    }
    return this.pouch.bulkDocs(docs)
  }
}

export default Merge
