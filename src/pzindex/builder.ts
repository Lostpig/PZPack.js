import * as path from 'path'

import type { PZFileBuilding, PZFolder } from '../types'
import { PZSubject } from '../utils/subscription'
import { folderRootId } from '../common/contants'
import { PZError, errorCodes } from '../exceptions'
import { nextTick } from '../utils/utils'
import { getContext } from '../common/context'
import { provider } from '../common/provider'

const ctx = getContext()

interface PZIndexNode {
  folder: PZFolder
  children: Map<string, PZFileBuilding | PZFolder>
}

const createPZFolder = (id: number, pid: number, name: string, fullname: string): PZFolder => {
  return { id, pid, name, fullname }
}
const createPZFile = (name: string, fullname: string, pid: number, source: string, size: number) => {
  const ext = path.extname(name)
  return <PZFileBuilding>{ name, ext, fullname, pid, source, size }
}

const isFolder = (item?: PZFileBuilding | PZFolder): item is PZFolder => {
  if (item && typeof (item as PZFolder).id === 'number') {
    return true
  }
  return false
}
const isFile = (item?: PZFileBuilding | PZFolder): item is PZFileBuilding => {
  if (item && typeof (item as PZFileBuilding).source === 'string') {
    return true
  }
  return false
}

export class PZIndexBuilder {
  private nodesMap = new Map<number, PZIndexNode>()
  private idCounter: () => number
  private change$ = new PZSubject<void>()
  get rootId() {
    return folderRootId
  }

  constructor() {
    const rootFolder = createPZFolder(folderRootId, 0, '', '')
    this.createNode(rootFolder)

    let idc = folderRootId + 1
    this.idCounter = () => idc++
  }

  private updateFlag: boolean = false
  private update() {
    if (this.updateFlag) return

    this.updateFlag = true
    nextTick().then(() => {
      this.change$.next()
      this.updateFlag = false
    })
  }
  private createNode(folder: PZFolder) {
    const node: PZIndexNode = {
      folder,
      children: new Map(),
    }
    this.nodesMap.set(folder.id, node)
  }
  private getNode(id: number) {
    return this.nodesMap.get(id)
  }

  changeObservble() {
    return this.change$.toObservable()
  }
  checkIsEmpty() {
    const files = this.getAllFiles()
    if (files.length === 0) throw new PZError(errorCodes.IndexBuilderEmpty)
  }

  addFile(source: string, pid: number, name: string) {
    const parent = this.getNode(pid)
    if (!parent) {
      throw new PZError(errorCodes.FolderNotFound, { id: pid })
    }
    if (parent.children.has(name)) {
      throw new PZError(errorCodes.DuplicateName, { name })
    }

    const { fileStatSync } = provider.get('fs-helper')
    const stat = fileStatSync(source)
    if (!stat.isFile()) {
      throw new PZError(errorCodes.FileNotFound, { path: name })
    }

    const fullname = path.join(parent.folder.fullname, name)
    const file = createPZFile(name, fullname, parent.folder.id, source, stat.size)
    parent.children.set(name, file)

    this.update()
    return file
  }
  addFolder(name: string, pid: number) {
    const parent = this.getNode(pid)
    if (!parent) {
      throw new PZError(errorCodes.FolderNotFound, { id: pid })
    }
    if (parent.children.has(name)) {
      throw new PZError(errorCodes.DuplicateName, { name })
    }

    const id = this.idCounter()
    const fullname = path.join(parent.folder.fullname, name)
    const folder = createPZFolder(id, parent.folder.id, name, fullname)

    parent.children.set(folder.name, folder)
    this.createNode(folder)

    this.update()
    return folder
  }
  ensureFolder(name: string, pid: number) {
    const parentNode = this.getNode(pid)
    if (parentNode) {
      const f = parentNode.children.get(name)
      if (isFolder(f)) {
        return f
      }
    }

    return this.addFolder(name, pid)
  }

  moveFile(file: PZFileBuilding, moveToPid: number, rename?: string) {
    const toNode = this.getNode(moveToPid)
    if (!toNode) {
      throw new PZError(errorCodes.FolderNotFound, { id: moveToPid })
    }

    const name = rename ?? file.name
    if (toNode.children.has(name)) {
      throw new PZError(errorCodes.DuplicateName, { name })
    }

    const fullname = path.join(toNode.folder.fullname, name)
    const newFile = createPZFile(name, fullname, toNode.folder.id, file.source, file.size)

    this.removeFile(file)
    toNode.children.set(name, newFile)
    this.update()
  }
  removeFile(file: PZFileBuilding) {
    const parent = this.getNode(file.pid)
    if (parent) {
      const f = parent.children.get(file.name)
      if (isFile(f)) {
        parent.children.delete(file.name)
        this.update()
      }
    }
  }
  moveFolder(folder: PZFolder, moveToPid: number, rename?: string) {
    if (folder.id === this.rootId) {
      ctx.logger?.warning('root folder cannot move')
      return
    }

    const fromNode = this.getNode(folder.pid)
    if (!fromNode) {
      throw new PZError(errorCodes.FolderNotFound, { id: folder.pid })
    }
    const toNode = this.getNode(moveToPid)
    if (!toNode) {
      throw new PZError(errorCodes.FolderNotFound, { id: moveToPid })
    }
    const selfNode = this.getNode(folder.id)
    if (!selfNode) {
      throw new PZError(errorCodes.FolderNotFound, { id: folder.id })
    }

    const name = rename ?? folder.name
    if (toNode.children.has(name)) {
      throw new PZError(errorCodes.DuplicateName, { name })
    }

    const fullname = path.join(toNode.folder.fullname, name)
    const newId = this.idCounter()
    const newFolder = createPZFolder(newId, moveToPid, name, fullname)
    selfNode.folder = newFolder
    this.nodesMap.delete(folder.id)
    this.nodesMap.set(newFolder.id, selfNode)

    fromNode.children.delete(folder.name)
    toNode.children.set(newFolder.name, newFolder)

    this.update()
  }
  removeFolder(folder: PZFolder) {
    const parent = this.nodesMap.get(folder.pid)
    if (parent) {
      const f = parent.children.get(folder.name)
      if (isFolder(f)) {
        parent.children.delete(folder.name)
        this.update()
      }
    }
    const node = this.nodesMap.get(folder.id)
    if (node) {
      this.nodesMap.delete(folder.id)
      for (const [, v] of node.children) {
        if (isFolder(v)) {
          this.removeFolder(v)
        }
      }
      this.update()
    }
  }

  getRoot() {
    return this.getFolder(folderRootId)!
  }
  getFolder(id: number) {
    return this.getNode(id)?.folder
  }
  getChildren(id: number) {
    const node = this.getNode(id)
    if (node) {
      const files: PZFileBuilding[] = []
      const folders: PZFolder[] = []
      for (const item of node.children.values()) {
        if (isFile(item)) files.push(item)
        else if (isFolder(item)) folders.push(item)
      }
      return { files, folders }
    }
    return { files: [], folders: [] }
  }
  getAllFiles() {
    const files: PZFileBuilding[] = []
    for (const node of this.nodesMap.values()) {
      for (const item of node.children.values()) {
        if (isFile(item)) files.push(item)
      }
    }
    return files
  }
  getAll() {
    const files: PZFileBuilding[] = []
    const folders: PZFolder[] = []

    for (const node of this.nodesMap.values()) {
      for (const item of node.children.values()) {
        if (isFile(item)) files.push(item)
        else if (isFolder(item)) folders.push(item)
      }
    }

    return { files, folders }
  }
}
export const serializePZIndexBuilder = (indexBuilder: PZIndexBuilder) => {
  const items = indexBuilder.getAll()
  return JSON.stringify({ items })
}
export const deserializePZIndexBuilder = (json: string) => {
  const data = JSON.parse(json) as { items: (PZFileBuilding | PZFolder)[] }
  const idxBuilder = new PZIndexBuilder()

  const files: PZFileBuilding[] = []
  const folders: PZFolder[] = []
  for (const item of data.items) {
    if (isFile(item)) files.push(item)
    else if (isFolder(item)) folders.push(item)
  }

  const pidMap = new Map<number, number>()
  const rebuildFolders = (folder: PZFolder) => {
    if (folder.id === idxBuilder.rootId) {
      pidMap.set(folder.id, folder.id)
    } else {
      const pid = pidMap.get(folder.pid)
      if (!pid) {
        throw new PZError(errorCodes.FolderNotFound, { id: 'undefined' })
      }

      const newFolder = idxBuilder.addFolder(folder.name, pid)
      pidMap.set(folder.id, newFolder.id)
    }

    const childFolders = folders.filter((f) => f.pid === folder.id)
    for (const cf of childFolders) {
      rebuildFolders(cf)
    }
  }
  rebuildFolders(idxBuilder.getRoot())

  for (const f of files) {
    const pid = pidMap.get(f.pid)
    if (!pid) {
      throw new PZError(errorCodes.FolderNotFound, { id: 'undefined' })
    }

    idxBuilder.addFile(f.source, pid, f.name)
  }

  return idxBuilder
}
