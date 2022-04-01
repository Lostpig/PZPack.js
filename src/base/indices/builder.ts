import * as path from 'path'
import * as fs from 'fs'
import { folderRootId } from '../common'
import { PZNotify } from '../subscription'
import { nextTick } from '../utils'
import type { PZFileBuilding, PZFilePacked, PZFolder, PZFolderChildren } from './types'
import { logger } from '../logger'

const encodeFile = (file: PZFilePacked) => {
  const nameBuf = Buffer.from(file.name, 'utf8')
  const tempBuf = Buffer.alloc(24)
  const fullLength = nameBuf.length + 20
  tempBuf.writeInt32LE(fullLength, 0)
  tempBuf.writeInt32LE(file.pid, 4)
  tempBuf.writeBigInt64LE(BigInt(file.offset), 8)
  tempBuf.writeBigInt64LE(BigInt(file.size), 16)

  return Buffer.concat([tempBuf, nameBuf])
}
const encodeFilePart = (files: PZFilePacked[]) => {
  const fileBytes: Uint8Array[] = []
  for (const f of files) {
    fileBytes.push(encodeFile(f))
  }
  return Buffer.concat(fileBytes)
}
const encodeFolder = (folder: PZFolder) => {
  const nameBuf = Buffer.from(folder.name, 'utf8')
  const tempBuf = Buffer.alloc(12)
  const fullLength = nameBuf.length + 8
  tempBuf.writeInt32LE(fullLength, 0)
  tempBuf.writeInt32LE(folder.id, 4)
  tempBuf.writeInt32LE(folder.pid, 8)

  return Buffer.concat([tempBuf, nameBuf])
}
const encodeFolderPart = (folders: PZFolder[]) => {
  const folderBytes: Uint8Array[] = []
  for (const f of folders) {
    folderBytes.push(encodeFolder(f))
  }
  return Buffer.concat(folderBytes)
}
const createPZFolder = (id: number, pid: number, name: string, fullname: string): PZFolder => {
  return { id, pid, name, fullname }
}
const createPZFile = (name: string, fullname: string, pid: number, source: string, size: number) => {
  const ext = path.extname(name)
  return <PZFileBuilding>{ name, ext, fullname, pid, source, size }
}

interface PZBuildingNode {
  bind: PZFolder
  files: Map<string, PZFileBuilding>
  folders: Map<string, PZFolder>
}

export class PZIndexBuilder {
  private nodesMap = new Map<number, PZBuildingNode>()
  private idCounter: () => number
  private notify: PZNotify<void> = new PZNotify()
  get subscriber() {
    return this.notify.asObservable()
  }
  get rootId() {
    return folderRootId
  }

  constructor() {
    const rootFolder = createPZFolder(folderRootId, 0, '', '')
    this.newNode(rootFolder)

    let idc = folderRootId + 1
    this.idCounter = () => idc++
  }

  private updateFlag: boolean = false
  private update() {
    if (this.updateFlag) return

    this.updateFlag = true
    nextTick().then(() => {
      this.notify.next()
      this.updateFlag = false
    })
  }

  private newNode(folder: PZFolder) {
    const node: PZBuildingNode = {
      bind: folder,
      files: new Map(),
      folders: new Map(),
    }
    this.nodesMap.set(folder.id, node)
  }
  private getNode(id: number) {
    return this.nodesMap.get(id)
  }
  checkEmpty() {
    const files = this.getAllFiles()
    if (files.length === 0) throw new Error('builder has not files')
  }

  addFile(source: string, pid: number, name: string) {
    const parent = this.getNode(pid)
    if (!parent) {
      throw new Error(`PZBuilder add file failed: folder id = "${pid}" not found`)
    }
    if (parent.files.has(name)) {
      throw new Error(`PZBuilder add file failed: file name "${name}" in parent is already exists`)
    }

    const stats = fs.statSync(source)
    if (!stats.isFile()) {
      throw new Error(`PZBuilder add file failed: source "${source}" is not a file`)
    }

    const fullname = path.join(parent.bind.fullname, name)
    const file = createPZFile(name, fullname, parent.bind.id, source, stats.size)
    parent.files.set(name, file)

    this.update()
    return file
  }
  addFolder(name: string, pid: number) {
    const parent = this.getNode(pid)
    if (!parent) {
      throw new Error(`PZBuilder add folder failed: parent folder id = "${pid}" not found`)
    }

    if (parent.folders.has(name)) {
      throw new Error(`PZBuilder add folder failed: folder name "${name}" in parent is already exists`)
    }

    const id = this.idCounter()
    const fullname = path.join(parent.bind.fullname, name)
    const folder = createPZFolder(id, parent.bind.id, name, fullname)

    parent.folders.set(folder.name, folder)
    this.newNode(folder)

    this.update()
    return folder
  }
  ensureFolder(name: string, pid: number) {
    const parentNode = this.getNode(pid)
    if (parentNode) {
      const f = parentNode.folders.get(name)
      if (f) {
        return f
      }
    }

    return this.addFolder(name, pid)
  }
  removeFile(file: PZFileBuilding) {
    const parent = this.getNode(file.pid)
    if (parent) {
      parent.files.delete(file.name)
      this.update()
    }
  }
  moveFile(file: PZFileBuilding, moveToPid: number, rename?: string) {
    const toNode = this.getNode(moveToPid)
    if (!toNode) {
      throw new Error(`PZBuilder move file failed: folder id = "${moveToPid}" not found`)
    }

    const name = rename ?? file.name
    if (toNode.files.has(name)) {
      throw new Error(`PZBuilder move file failed: file name "${name}" in parent is already exists`)
    }

    const fullname = path.join(toNode.bind.fullname, name)
    const newFile = createPZFile(name, fullname, toNode.bind.id, file.source, file.size)

    this.removeFile(file)
    toNode.files.set(name, newFile)
    this.update()
  }
  moveFolder(folder: PZFolder, moveToPid: number, rename?: string) {
    if (folder.id === this.rootId) {
      logger.warning('root folder cannot move')
      return
    }

    const fromNode = this.getNode(folder.pid)
    if (!fromNode) {
      throw new Error(`PZBuilder move folder failed: parent id = "${folder.pid}" not found`)
    }
    const toNode = this.getNode(moveToPid)
    if (!toNode) {
      throw new Error(`PZBuilder move folder failed: parent id = "${moveToPid}" not found`)
    }
    const selfNode = this.getNode(folder.id)
    if (!selfNode) {
      throw new Error(`PZBuilder move folder failed: folder id = "${folder.id}" not found`)
    }

    const name = rename ?? folder.name
    if (toNode.folders.has(name)) {
      throw new Error(`PZBuilder move folder failed: folder name "${name}" in parent is already exists`)
    }

    const fullname = path.join(toNode.bind.fullname, name)
    const newId = this.idCounter()
    const newFolder = createPZFolder(newId, moveToPid, name, fullname)
    selfNode.bind = newFolder
    this.nodesMap.delete(folder.id)
    this.nodesMap.set(newFolder.id, selfNode)

    fromNode.folders.delete(folder.name)
    toNode.folders.set(newFolder.name, newFolder)

    this.update()
  }
  removeFolder(folder: PZFolder) {
    const parent = this.nodesMap.get(folder.pid)
    if (parent) {
      parent.folders.delete(folder.name)
    }
    const node = this.nodesMap.get(folder.id)
    if (node) {
      this.nodesMap.delete(folder.id)
      for (const [, v] of node.folders) {
        this.removeFolder(v)
      }
    }

    this.update()
  }

  getRootFolder() {
    return this.getFolder(folderRootId)
  }
  getFolder(id: number) {
    return this.getNode(id)?.bind
  }
  getChildren(id: number) {
    const node = this.getNode(id)
    if (node) {
      return <PZFolderChildren<PZFileBuilding>>{
        files: [...node.files.values()],
        folders: [...node.folders.values()],
      }
    }
    return <PZFolderChildren<PZFileBuilding>>{
      files: [],
      folders: [],
    }
  }
  getAllFiles() {
    const files: PZFileBuilding[] = []
    for (const node of this.nodesMap.values()) {
      files.push(...node.files.values())
    }

    return files
  }
  getAll() {
    const files: PZFileBuilding[] = []
    const folders: PZFolder[] = []

    for (const node of this.nodesMap.values()) {
      files.push(...node.files.values())
      folders.push(...node.folders.values())
    }

    return { files, folders }
  }
}
export class PZIndexEncoder {
  private builder: PZIndexBuilder
  private files: PZFilePacked[] = []
  private folders = new Map<number, PZFolder>()
  constructor(builder: PZIndexBuilder) {
    this.builder = builder
  }

  addFile(bfile: PZFileBuilding, offset: number, size: number) {
    this.ensureFolder(bfile.pid)

    this.files.push({ name: bfile.name, fullname: bfile.fullname, pid: bfile.pid, ext: bfile.ext, offset, size })
  }
  ensureFolder(id: number) {
    if (id === 0 || id === folderRootId) return
    if (this.folders.has(id)) return

    const f = this.builder.getFolder(id)
    if (!f) {
      throw new Error(`PZIndex encode failed: file's folder id = "${id} not found in builder"`)
    }
    this.folders.set(id, f)
    this.ensureFolder(f.pid)
  }
  encode() {
    const fileBytes = encodeFilePart(this.files)
    const folderBytes = encodeFolderPart([...this.folders.values()])

    const lenBuf = Buffer.alloc(8)
    lenBuf.writeInt32LE(folderBytes.length, 0)
    lenBuf.writeInt32LE(fileBytes.length, 4)

    return Buffer.concat([lenBuf, folderBytes, fileBytes])
  }
}

export const serializeIndex = (indexBuilder: PZIndexBuilder) => {
  const { files, folders } = indexBuilder.getAll()
  return JSON.stringify({ files, folders })
}
export const deserializeIndex = (json: string) => {
  const data = JSON.parse(json) as ReturnType<PZIndexBuilder['getAll']>
  const idxBuilder = new PZIndexBuilder()

  const pidMap = new Map<number, number>()
  const rebuildFolders = (folder: PZFolder) => {
    if (folder.id === idxBuilder.rootId) {
      pidMap.set(folder.id, folder.id)
    } else {
      const pid = pidMap.get(folder.pid)
      if (!pid) throw new Error('deserialize index failed, pid not found')

      const newFolder = idxBuilder.addFolder(folder.name, pid)
      pidMap.set(folder.id, newFolder.id)
    }

    const childFolders = data.folders.filter(f => f.pid === folder.id)
    for (const cf of childFolders) {
      rebuildFolders(cf)
    }
  }
  rebuildFolders(idxBuilder.getRootFolder()!)

  for (const f of data.files) {
    const pid = pidMap.get(f.pid)
    if (!pid) throw new Error('deserialize index failed, pid not found')

    idxBuilder.addFile(f.source, pid, f.name)
  }

  return idxBuilder
}