import type { FileHandle } from 'fs/promises'
import { sha256 } from './utils/hash'
import { taskManager, type CancelToken, type AsyncTask } from './utils/task'
import { PZSubject } from './utils/subscription'
import { currentVersion, pzSign } from './common/contants'
import { createPZCrypto, type PZCrypto, type EncryptFileProgress } from './common/crypto'
import { provider } from './common/provider'
import { getContext } from './common/context'
import { PZError, errorCodes } from './exceptions'
import type { PZIndexBuilder } from './pzindex/builder'

const ctx = getContext()

export interface PZBuildOptions {
  password: string | Buffer
  target: string
  blockSize: number
  frequency?: number
}
export interface BuildProgress {
  /** 阶段 */
  phase: 'prepare' | 'process' | 'complete'
  /** 当前文件已写入字节数 */
  currentWrittenBytes: number
  /** 当前文件总字节数 */
  currentTotalBytes: number
  /** 合计已写入字节数 */
  sumWrittenBytes: number
  /** 合计总字节数 */
  sumTotalBytes: number
  /** 已打包文件个数 */
  filePackedCount: number
  /** 总文件个数 */
  fileTotalCount: number
}
interface BuildContext {
  target: string
  crypto: PZCrypto
  indices: PZIndexBuilder
  task: AsyncTask<BuildProgress>
  cancelToken: CancelToken
  blockSize: number
  frequency?: number
}
interface PZFileEncoder {
  chunk: number
  fid: number
  pid: number
  offset: number
  size: number
  originSize: number
  name: Buffer
  source: string
}
interface PZFolderEncoder {
  chunk: number
  id: number
  pid: number
  name: Buffer
}

const createIndexStore = (idxBuilder: PZIndexBuilder) => {
  const fileStore: PZFileEncoder[] = []
  const folderStore: PZFolderEncoder[] = []
  const fidCounter = (() => {
    let i = 1
    return () => i++
  })()

  let totalSize = 8
  const { files, folders } = idxBuilder.getAll()
  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf8')
    const fe: PZFileEncoder = {
      chunk: nameBuffer.length + 36,
      fid: fidCounter(),
      pid: file.pid,
      offset: 0,
      size: 0,
      originSize: file.size,
      name: nameBuffer,
      source: file.source,
    }
    fileStore.push(fe)
    totalSize += fe.chunk
  }
  for (const folder of folders) {
    const nameBuffer = Buffer.from(folder.name, 'utf8')
    const fe: PZFolderEncoder = {
      chunk: nameBuffer.length + 12,
      pid: folder.pid,
      id: folder.id,
      name: nameBuffer,
    }
    folderStore.push(fe)
    totalSize += fe.chunk
  }

  return { totalSize, fileStore, folderStore }
}
/**
 * 写入PZPK文件头部
 * @param handle 文件handle
 * @param crypto PZCrypto加密器
 * @param total 文件总大小
 * @param blockSize 块大小
 * @param indexSize 索引区大小
 */
const writeHead = async (handle: FileHandle, crypto: PZCrypto, total: bigint, blockSize: number, indexSize: number) => {
  // write version [0 ~ 3]
  const versionBuf = Buffer.alloc(4)
  versionBuf.writeInt32LE(currentVersion, 0)
  handle.write(versionBuf, 0, versionBuf.length, 0)

  // write pzpack sign hash [4 ~ 35]
  const signBuf = sha256(pzSign)
  handle.write(signBuf, 0, signBuf.length, 4)

  // write password check hash [36 ~ 67]
  const pwHash = crypto.pwHash
  handle.write(pwHash, 0, pwHash.length, 36)

  // write create timestamp [68 ~ 75]
  const timestamp = BigInt(Date.now())
  const timestampBuf = Buffer.alloc(8)
  timestampBuf.writeBigInt64LE(timestamp, 0)
  handle.write(timestampBuf, 0, timestampBuf.length, 68)

  // write file total size [76 ~ 83]
  const totalSizeBuf = Buffer.alloc(8)
  totalSizeBuf.writeBigInt64LE(total, 0)
  handle.write(totalSizeBuf, 0, totalSizeBuf.length, 76)

  // write block size [84 ~ 87]
  const blockSizeBuf = Buffer.alloc(4)
  blockSizeBuf.writeInt32LE(blockSize, 0)
  handle.write(blockSizeBuf, 0, blockSizeBuf.length, 84)

  // write index size [88 ~ 91]
  const indexSizeBuf = Buffer.alloc(4)
  indexSizeBuf.writeInt32LE(indexSize, 0)
  handle.write(indexSizeBuf, 0, indexSizeBuf.length, 88)
}
const writeIndex = async (handle: FileHandle, crypto: PZCrypto, indexStore: ReturnType<typeof createIndexStore>) => {
  const { totalSize, fileStore, folderStore } = indexStore
  const contentBuffer = Buffer.alloc(totalSize)

  let folderPartSize = 0
  let offset = 8
  for (const folder of folderStore) {
    contentBuffer.writeInt32LE(folder.chunk, offset)
    contentBuffer.writeInt32LE(folder.id, offset + 4)
    contentBuffer.writeInt32LE(folder.pid, offset + 8)
    contentBuffer.set(folder.name, offset + 12)

    offset += folder.chunk
    folderPartSize += folder.chunk
  }

  let filePartSize = 0
  for (const file of fileStore) {
    contentBuffer.writeInt32LE(file.chunk, offset)
    contentBuffer.writeInt32LE(file.fid, offset + 4)
    contentBuffer.writeInt32LE(file.pid, offset + 8)
    contentBuffer.writeBigInt64LE(BigInt(file.offset), offset + 12)
    contentBuffer.writeBigInt64LE(BigInt(file.size), offset + 20)
    contentBuffer.writeBigInt64LE(BigInt(file.originSize), offset + 28)
    contentBuffer.set(file.name, offset + 36)

    offset += file.chunk
    filePartSize += file.chunk
  }

  contentBuffer.writeInt32LE(folderPartSize, 0)
  contentBuffer.writeInt32LE(filePartSize, 4)

  const encryptedBuffer = crypto.encrypt(contentBuffer)
  await handle.write(encryptedBuffer, 0, encryptedBuffer.length, 92)

  return encryptedBuffer.length
}

const execBuild = async (context: BuildContext) => {
  const { target, indices, crypto, cancelToken, frequency, blockSize, task } = context
  const { ensureFile, removeFile, renameFile } = provider.get('fs-helper')

  const tempFile = target + '.pztemp'
  const targetHandle = await ensureFile(target, 'wx')
  const tempHandle = await ensureFile(tempFile, 'wx')

  const indexStore = createIndexStore(indices)
  const sumTotalSize = indexStore.fileStore.reduce((p, c) => p + c.originSize, 0)
  taskManager.update(task, {
    sumTotalBytes: sumTotalSize,
    sumWrittenBytes: 0,
    filePackedCount: 0,
    fileTotalCount: indexStore.fileStore.length,
  })

  const progress$ = new PZSubject<EncryptFileProgress>()

  taskManager.update(task, { phase: 'process' })
  const encryptedIndexSize = 16 - (indexStore.totalSize % 16) + indexStore.totalSize + 16
  let offset = 92 + encryptedIndexSize
  let fileCount = 0
  let sumReaded = 0

  progress$.subscribe((p) =>
    taskManager.update(task, { currentWrittenBytes: p.readedBytes, sumWrittenBytes: sumReaded + p.readedBytes }),
  )
  for (const f of indexStore.fileStore) {
    if (cancelToken.canceled) break

    const sourceHandle = await ensureFile(f.source, 'r')
    const sourceStat = await sourceHandle.stat()
    taskManager.update(task, { currentWrittenBytes: 0, currentTotalBytes: sourceStat.size })

    const encryptedSize = await crypto.encryptFile(sourceHandle, tempHandle, {
      position: 0,
      size: sourceStat.size,
      offset: offset,
      blockSize,
      cancelToken,
      progress: progress$,
      frequency,
    })

    f.originSize = sourceStat.size
    f.size = encryptedSize
    f.offset = offset

    offset += encryptedSize
    sumReaded += sourceStat.size
    fileCount++
    taskManager.update(task, { filePackedCount: fileCount, sumWrittenBytes: sumReaded })
  }

  taskManager.update(task, { phase: 'complete', filePackedCount: fileCount })
  if (!cancelToken.canceled) {
    const writtenIndexSize = await writeIndex(tempHandle, crypto, indexStore)
    ctx.logger?.debug(
      `execBuild: computed index size = ${encryptedIndexSize}, written index size = ${writtenIndexSize}`,
    )
    ctx.logger?.debug(`execBuild: created file size = ${offset}`)
    await writeHead(tempHandle, crypto, BigInt(offset), blockSize, writtenIndexSize)

    await targetHandle.close()
    await tempHandle.close()
    await removeFile(target)
    await renameFile(tempFile, target)
  } else {
    await targetHandle.close()
    await tempHandle.close()
    await removeFile(target)
    await removeFile(tempFile)
  }
}

export const buildPZPackFile = (indices: PZIndexBuilder, options: PZBuildOptions) => {
  const { password, target, frequency, blockSize } = options

  const { fileExistsSync } = provider.get('fs-helper')
  const targetExists = fileExistsSync(target)
  if (targetExists) {
    throw new PZError(errorCodes.PathAlreadyExists, { path: target })
  }

  const crypto = createPZCrypto(password)
  const [task, cancelToken] = taskManager.create<BuildProgress>({
    phase: 'prepare',
    currentWrittenBytes: 0,
    currentTotalBytes: 0,
    sumWrittenBytes: 0,
    sumTotalBytes: 0,
    filePackedCount: 0,
    fileTotalCount: 0,
  })

  execBuild({ target, crypto, indices, task, cancelToken, blockSize, frequency })
    .then(() => {
      taskManager.complete(task)
    })
    .catch((err) => {
      taskManager.throwError(task, err)
    })

  return task
}
