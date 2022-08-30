import * as path from 'path'
import { folderRootId } from '../common/contants'
import type { PZFilePacked, PZFolder } from '../types'
import { getContext } from '../common/context'
import { errorCodes, PZError } from '../exceptions'

const createPZFilePacked = (
  name: string,
  fullname: string,
  fid: number,
  pid: number,
  offset: number,
  size: number,
  originSize: number,
): PZFilePacked => {
  const ext = path.extname(fullname)
  return {
    name,
    fullname,
    ext,
    fid,
    pid,
    offset,
    size,
    originSize,
  }
}
const createPZFolder = (id: number, pid: number, name: string, fullname: string): PZFolder => {
  return {
    id,
    pid,
    name,
    fullname,
  }
}
const createPZIndexNode = (folder: PZFolder): PZIndexNode => {
  return {
    folder,
    childFolders: new Map<string, PZFolder>(),
    childFiles: new Map<string, PZFilePacked>(),
  }
}

const ctx = getContext()

const decodeIndexBytes = (data: Buffer) => {
  const folderPartSize = data.readInt32LE(0)
  const filePartSize = data.readInt32LE(4)

  ctx.logger?.debug(`decodeIndexBytes: data size = ${data.byteLength}, computed size = ${8 + folderPartSize + filePartSize}`)
  if (data.byteLength !== 8 + folderPartSize + filePartSize) {
    throw new PZError(errorCodes.ParameterInvaild, { parameter: 'data', value: '[bytes]' })
  }

  const foldersBuf = data.slice(8, 8 + folderPartSize)
  const filesBuf = data.slice(8 + folderPartSize, 8 + folderPartSize + filePartSize)

  // create root node
  const rootFolder = createPZFolder(folderRootId, 0, '', '')
  const rootNode = createPZIndexNode(rootFolder)
  const nodes = new Map<number, PZIndexNode>()
  nodes.set(rootFolder.id, rootNode)

  // decode folders
  let offset = 0
  const tempFolderStore = new Map<number, PZFolder>()
  while (offset < foldersBuf.byteLength) {
    const chunkSize = foldersBuf.readInt32LE(offset)
    const id = foldersBuf.readInt32LE(offset + 4)
    const pid = foldersBuf.readInt32LE(offset + 8)
    const name = foldersBuf.toString('utf8', offset + 12, offset + chunkSize)

    const folder = createPZFolder(id, pid, name, '')
    tempFolderStore.set(folder.id, folder)

    offset += chunkSize
  }
  const getNode = (id: number) => {
    let node = nodes.get(id)
    if (node) return node

    const folder = tempFolderStore.get(id)
    if (!folder) {
      throw new PZError(errorCodes.FolderNotFound, { id })
    }

    const parentNode = getNode(folder.pid)
    if (!parentNode) {
      throw new PZError(errorCodes.FolderNotFound, { id: folder.pid })
    }

    const fullName = path.join(parentNode.folder.fullname, folder.name)
    const nodeFolder = createPZFolder(id, folder.pid, folder.name, fullName)
    parentNode.childFolders.set(nodeFolder.name, nodeFolder)
    node = createPZIndexNode(nodeFolder)
    nodes.set(nodeFolder.id, node)

    return node
  }

  // create files
  offset = 0
  while (offset < filesBuf.byteLength) {
    const chunkSize = filesBuf.readInt32LE(offset)
    const fid = filesBuf.readInt32LE(offset + 4)
    const pid = filesBuf.readInt32LE(offset + 8)
    const fileOffset = Number(filesBuf.readBigInt64LE(offset + 12))
    const fileSize = Number(filesBuf.readBigInt64LE(offset + 20))
    const originSize = Number(filesBuf.readBigInt64LE(offset + 28))
    const name = filesBuf.toString('utf8', offset + 36, offset + chunkSize)

    const parentNode = getNode(pid)
    const fullname = path.join(parentNode.folder.fullname, name)
    const file = createPZFilePacked(name, fullname, fid, pid, fileOffset, fileSize, originSize)
    parentNode.childFiles.set(file.name, file)

    offset += chunkSize
  }

  return nodes
}
interface PZIndexNode {
  folder: PZFolder
  childFolders: Map<string, PZFolder>
  childFiles: Map<string, PZFilePacked>
}
class PZIndexLoader {
  get root () {
    return this.nodes.get(folderRootId)!.folder
  }

  private files: Map<number, PZFilePacked>
  private nodes: Map<number, PZIndexNode>
  constructor(nodes: Map<number, PZIndexNode>) {
    this.nodes = nodes
    this.files = new Map()
    this.createFilesCache()
  }
  private createFilesCache () {
    for (const node of this.nodes.values()) {
      node.childFiles.forEach(f => this.files.set(f.fid, f))
    }
  }
  private getNode (id: number) {
    return this.nodes.get(id)
  }

  fileOfId(id: number) {
    return this.files.get(id)
  }
  folderOfId(id: number) {
    return this.nodes.get(id)?.folder
  }

  getFile (fullname: string) {
    const parts = fullname.replace(/\\/gm, '/').split('/').filter(s => !!s).reverse()

    let folder: PZFolder | undefined = this.root
    while (parts.length > 1) {
      if (!folder) return undefined
      const p = parts.pop()!
      folder = this.findFolder(folder, p)
    }

    if (!folder) return undefined
    const filename = parts.pop()!
    return this.findFile(folder, filename)
  }
  getFolder (fullname: string) {
    const parts = fullname.replace(/\\/gm, '/').split('/').filter(s => !!s).reverse()

    let folder: PZFolder | undefined = this.root
    while (parts.length > 0) {
      if (!folder) return undefined
      const p = parts.pop()!
      folder = this.findFolder(folder, p)
    }

    return folder
  }

  findFile(folder: PZFolder, name: string) {
    const node = this.getNode(folder.id)
    if (node) {
      return node.childFiles.get(name)
    }
    return undefined
  }
  findFolder(parent: PZFolder, name: string) {
    const node = this.getNode(parent.id)
    if (node) {
      return node.childFolders.get(name)
    }
    return undefined
  }

  getChildren (folder: PZFolder) {
    const node = this.getNode(folder.id)
    if (node) {
      return {
        files: [...node.childFiles.values()],
        folders: [...node.childFolders.values()],
      }
    }
    return {
      files: [],
      folders: [],
    }
  }
  getChildrenFiles (folder: PZFolder) {
    const node = this.getNode(folder.id)
    if (node) {
      return [...node.childFiles.values()]
    }
    return []
  }
  getChildrenFolders (folder: PZFolder) {
    const node = this.getNode(folder.id)
    if (node) {
      return [...node.childFolders.values()]
    }
    return []
  }

  getAllFiles() {
    return this.getFilesDeep(this.root)
  }
  getFilesDeep(folder: PZFolder) {
    const files: PZFilePacked[] = []

    const findFiles = (f: PZFolder) => {
      const node = this.nodes.get(f.id)
      if (node) {
        files.push(...node.childFiles.values())
        for (const childFolder of node.childFolders.values()) {
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
    const list: PZFolder[] = []
    list.push(folder)

    let parent = this.getNode(folder.pid)
    while (parent) {
      list.push(parent.folder)
      parent = this.getNode(parent.folder.pid)
    }

    return list.reverse()
  }
}

export const craeteIndexLoader = (data: Buffer) => {
  const nodes = decodeIndexBytes(data)
  const loader = new PZIndexLoader(nodes)

  return loader
}
export type { PZIndexLoader }