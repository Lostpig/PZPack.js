import * as path from 'path'
import { folderRootId } from '../common'
import { PZNotify } from '../subscription'
import type { PZFilePacked, PZFolder, PZFolderChildren } from './types'

const decodeFileCurrent = (buf: Buffer, position: number, length: number) => {
  const folderId = buf.readInt32LE(position)
  const offset = Number(buf.readBigInt64LE(position + 4))
  const size = Number(buf.readBigInt64LE(position + 12))
  const name = buf.toString('utf8', position + 20, position + length)

  return <[string, number, number, number]>[name, folderId, offset, size]
}
const decodeFileV1 = (buf: Buffer, position: number, length: number) => {
  const folderId = buf.readInt32LE(position)
  const offset = Number(buf.readBigInt64LE(position + 4))
  const size = buf.readInt32LE(position + 12)
  const name = buf.toString('utf8', position + 16, position + length)

  return <[string, number, number, number]>[name, folderId, offset, size]
}
const decodeFile = (version: number, buf: Buffer, position: number, length: number) => {
  switch (version) {
    case 1:
      return decodeFileV1(buf, position, length)
      break
    default:
      return decodeFileCurrent(buf, position, length)
      break
  }
}

const decodeFolder = (buf: Buffer, position: number, length: number) => {
  const id = buf.readInt32LE(position)
  const pid = buf.readInt32LE(position + 4)
  const name = buf.toString('utf8', position + 8, position + length)
  return <[number, number, string]>[id, pid, name]
}

const createPZFolder = (id: number, pid: number, name: string, fullname: string): PZFolder => {
  return {
    id,
    pid,
    name,
    fullname,
  }
}

export class PZIndexReader {
  readonly root: PZFolder
  private folderChildrenMap = new WeakMap<PZFolder, PZFolderChildren<PZFilePacked>>()
  private foldersMap = new Map<number, PZFolder>()
  private notify: PZNotify<void> = new PZNotify()
  get subscriber() {
    return this.notify.asObservable()
  }

  constructor() {
    this.root = createPZFolder(folderRootId, 0, '', '')
  }
  private update() {
    this.notify.next()
  }

  private addFolder(id: number, name: string, parent: PZFolder) {
    const fullname = path.join(parent.fullname, name)
    const folder: PZFolder = { id, name, fullname, pid: parent.id }

    const c = this.getChildren(parent)

    this.foldersMap.set(folder.id, folder)
    c.folders.push(folder)

    return folder
  }
  private addFile(name: string, pid: number, offset: number, size: number) {
    const folder = this.getFolder(pid)
    if (!folder) {
      throw new Error(`PZIndexReader decode failed: files parent id = [${pid}] not found`)
    }
    const c = this.getChildren(folder)
    const fullname = path.join(folder.fullname, name)
    const ext = path.extname(fullname)

    c.files.push({ name, fullname, pid, offset, size, ext })
  }
  private decodeFolders(buf: Buffer) {
    const tempMap = new Map<number, [number, number, string]>()

    let position = 0
    while (position < buf.length) {
      const length = buf.readInt32LE(position)
      const [id, pid, name] = decodeFolder(buf, position + 4, length)
      tempMap.set(id, [id, pid, name])
      position += 4 + length
    }

    const newFolder = (id: number): PZFolder => {
      const self = this.getFolder(id)
      if (self) return self

      const [, pid, name] = tempMap.get(id)!
      let parent = this.getFolder(pid)
      if (!parent) {
        parent = newFolder(pid)
      }
      return this.addFolder(id, name, parent)
    }
    for (const [k] of tempMap) {
      newFolder(k)
    }
  }
  private decodeFiles(buf: Buffer, version: number) {
    let position = 0
    while (position < buf.length) {
      const length = buf.readInt32LE(position)
      const [name, pid, offset, size] = decodeFile(version, buf, position + 4, length)
      this.addFile(name, pid, offset, size)

      position += 4 + length
    }
  }
  decode(buf: Buffer, version: number) {
    this.clear()
    const folderPartSize = buf.readInt32LE(0)
    const filePartSize = buf.readInt32LE(4)

    const folderPartBuf = buf.slice(8, 8 + folderPartSize)
    const filePartBuf = buf.slice(8 + folderPartSize, 8 + folderPartSize + filePartSize)

    this.decodeFolders(folderPartBuf)
    this.decodeFiles(filePartBuf, version)

    this.update()
  }
  clear() {
    this.foldersMap.clear()
    this.update()
  }

  getFolder(id: number) {
    if (id === folderRootId) {
      return this.root
    } else {
      return this.foldersMap.get(id)
    }
  }
  getChildren(folder: PZFolder) {
    let childern = this.folderChildrenMap.get(folder)
    if (!childern) {
      childern = { files: [], folders: [] }
      this.folderChildrenMap.set(folder, childern)
    }

    return childern
  }
  getAllFiles() {
    return this.getFilesDeep(this.root)
  }
  getFilesDeep(folder: PZFolder) {
    const files: PZFilePacked[] = []

    const findFiles = (f: PZFolder) => {
      const c = this.folderChildrenMap.get(f)
      if (c) {
        files.push(...c.files)
        for (const childFolder of c.folders) {
          findFiles(childFolder)
        }
      }
    }
    findFiles(folder)

    return files
  }
  resolvePath(file: PZFilePacked, folder: PZFolder) {
    const p = path.relative(folder.fullname, file.fullname)
    return path.join(folder.name, p)
  }
  getFoldersToRoot(folder: PZFolder) {
    const list = []
    list.push(folder)

    let parent = this.getFolder(folder.pid)
    while (parent) {
      list.push(parent)
      parent = this.getFolder(parent.pid)
    }

    return list.reverse()
  }
}
