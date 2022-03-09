import * as path from 'path'
import * as fs from 'fs'
import { folderRootId } from '../common'
import { PZNotify } from '../subscription'
import { nextTick } from '../utils'
import type { PZFileBuilding, PZFilePacked, PZFolder, PZFolderChildren } from './types'

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
  return <PZFileBuilding>{ name, fullname, pid, source, size }
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
    const ext = path.extname(fullname)
    this.removeFile(file)
    toNode.files.set(name, { name, fullname, pid: toNode.bind.id, size: file.size, source: file.source, ext })

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
