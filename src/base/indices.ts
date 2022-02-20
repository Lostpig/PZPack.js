import * as path from 'path'
import { folderRootId } from './common'

export interface PZFile {
  readonly name: string
  readonly folderId: number
  readonly offset: number
  readonly size: number
}
export interface PZFolder {
  readonly id: number
  readonly pid: number
  readonly name: string
}
export const createPZFile = (name: string, folderId: number, offset: number, size: number): PZFile => {
  return { name, folderId, offset, size }
}
export const createPZFolder = (name: string, id: number, pid: number): PZFolder => {
  return { name, id, pid }
}

export class PZIndex {
  private _root: PZFolder
  private folderChildren: Map<number, PZFolder[]>
  private fileChildren: Map<number, PZFile[]>
  private files: PZFile[]
  private foldersMap: Map<number, PZFolder>
  private fullnameCache: WeakMap<PZFolder | PZFile, string>

  get root() {
    return this._root
  }
  constructor(files: PZFile[], folders: PZFolder[]) {
    this._root = createPZFolder('root', folderRootId, 0)

    this.files = files
    this.fileChildren = this.createFilesChildren(files)

    const { foldersMap, folderChildren } = this.createFoldersMap(folders)
    this.folderChildren = folderChildren
    this.foldersMap = foldersMap
    this.fullnameCache = new WeakMap()
  }
  private createFilesChildren(files: PZFile[]) {
    const fileChildren = new Map<number, PZFile[]>()
    for (const file of files) {
      let list = fileChildren.get(file.folderId)
      if (!list) {
        list = []
        fileChildren.set(file.folderId, list)
      }
      list.push(file)
    }

    return fileChildren
  }
  private createFoldersMap(folders: PZFolder[]) {
    const folderChildren = new Map<number, PZFolder[]>()
    const foldersMap = new Map<number, PZFolder>()

    for (const folder of folders) {
      foldersMap.set(folder.id, folder)
      let list = folderChildren.get(folder.pid)
      if (!list) {
        list = []
        folderChildren.set(folder.pid, list)
      }
      list.push(folder)
    }

    return { foldersMap, folderChildren }
  }

  getChildren(folderId: number) {
    const files = this.getChildrenFiles(folderId)
    const folders = this.getChildrenFolders(folderId)

    return { files, folders }
  }
  getChildrenFiles(folderId: number) {
    const list = this.fileChildren.get(folderId)
    return list ? [...list] : []
  }
  getChildrenFolders(folderId: number) {
    const list = this.folderChildren.get(folderId)
    return list ? [...list] : []
  }
  getAllFiles() {
    return [...this.files]
  }
  getFolderPath(folderId: number): string {
    if (folderId === folderRootId) { return "" }

    const folder = this.foldersMap.get(folderId)
    if (!folder) {
      throw new Error(`DataError: folder id ${folderId} not found`)
    }

    if (folder.pid === folderRootId) {
      return folder.name
    } else {
      return path.join(this.getFolderPath(folder.pid), folder.name)
    }
  }
  getFullName (file: PZFile) {
    let fullname = this.fullnameCache.get(file)
    if (!fullname) {
      const folderPath = this.getFolderPath(file.folderId)
      fullname = path.join(folderPath, file.name)

      this.fullnameCache.set(file, fullname)
    }

    return fullname
  }
}


const decodeFileCurrent = (buf: Buffer, position: number, length: number) => {
  const folderId = buf.readInt32LE(position)
  const offset = Number(buf.readBigInt64LE(position + 4))
  const size = Number(buf.readBigInt64LE(position + 12))
  const name = buf.toString('utf8', position + 20, position + length)

  return createPZFile(name, folderId, offset, size)
}
const decodeFileV1 = (buf: Buffer, position: number, length: number) => {
  const folderId = buf.readInt32LE(position)
  const offset = Number(buf.readBigInt64LE(position + 4))
  const size = buf.readInt32LE(position + 12)
  const name = buf.toString('utf8', position + 16, position + length)

  return createPZFile(name, folderId, offset, size)
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
const decodeFilePart = (buf: Buffer, version: number) => {
  const files: PZFile[] = []

  let position = 0
  while (position < buf.length) {
    const length = buf.readInt32LE(position)
    const file = decodeFile(version, buf, position + 4, length)
    files.push(file)

    position += 4 + length
  }

  return files
}

const decodeFolder = (buf: Buffer, position: number, length: number) => {
  const id = buf.readInt32LE(position)
  const pid = buf.readInt32LE(position + 4)
  const name = buf.toString('utf8', position + 8, position + length)

  return createPZFolder(name, id, pid)
}
const decodeFolderPart = (buf: Buffer) => {
  const folders: PZFolder[] = []

  let position = 0
  while (position < buf.length) {
    const length = buf.readInt32LE(position)
    const folder = decodeFolder(buf, position + 4, length)

    if (folder.id !== folderRootId) {
      folders.push(folder)
    }

    position += 4 + length
  }

  return folders
}

export const decodePZIndex = (buf: Buffer, version: number) => {
  const folderPartSize = buf.readInt32LE(0)
  const filePartSize = buf.readInt32LE(4)

  const folderPartBuf = buf.slice(8, 8 + folderPartSize)
  const filePartBuf = buf.slice(8 + folderPartSize, 8 + folderPartSize + filePartSize)

  const folders = decodeFolderPart(folderPartBuf)
  const files = decodeFilePart(filePartBuf, version)

  return new PZIndex(files, folders)
}
