import { PZLogger, LogLevel, ctxCtrl, type FSHelperModule } from '../src'

const createMockStat = (file: MockFileHandle) => {
  return {
    isDirectory() {
      return false
    },
    isFile() {
      return true
    },
    size: file.size,
  }
}
export interface MockFileReadOptions {
  buffer: Buffer
  offset: number
  position: number
  length: number
}
export class MockFileHandle {
  innerBuffer: Buffer
  get size() {
    return this.innerBuffer.length
  }
  constructor(innerBuffer: Buffer) {
    this.innerBuffer = innerBuffer
  }
  read(options: MockFileReadOptions) {
    const buffer = options.buffer
    const start = options.position
    let end = start + options.length
    if (end > this.innerBuffer.length) {
      end = this.innerBuffer.length
    }

    this.innerBuffer.copy(buffer, options.offset, start, end)
    const bytesRead = end - start

    return Promise.resolve({ buffer, bytesRead })
  }
  write(buffer: Buffer, offset: number, length: number, position: number) {
    const size = position + length
    if (size > this.innerBuffer.length) {
      const newBuffer = Buffer.allocUnsafeSlow(size)
      this.innerBuffer.copy(newBuffer, 0, 0)
      this.innerBuffer = newBuffer
    }

    buffer.copy(this.innerBuffer, position, offset, offset + length)
    const bytesWritten = length
    return Promise.resolve({ buffer, bytesWritten })
  }
  stat() {
    const stat = createMockStat(this)
    return Promise.resolve(stat)
  }
  close() {
    return Promise.resolve()
  }
}

export const fileStore = new Map<string, MockFileHandle>()
export const MockFSHelper: FSHelperModule = {
  dirExists: () => Promise.resolve(true),
  fileExists: (file: string) => {
    const exists = fileStore.has(file)
    return Promise.resolve(exists)
  },
  ensureDir: (dir: string) => Promise.resolve(dir),
  ensureFile: (file: string) => {
    let f = fileStore.get(file)
    if (!f) {
      f = new MockFileHandle(Buffer.alloc(65536))
      fileStore.set(file, f)
    }
    return Promise.resolve<any>(f)
  },
  removeFile(file: string) {
    fileStore.delete(file)
    return Promise.resolve()
  },
  renameFile(oldPath, newPath) {
    const f = fileStore.get(oldPath)
    if (f) {
      fileStore.set(newPath, f)
      fileStore.delete(oldPath)
    }
    return Promise.resolve()
  },
  fileExistsSync(file: string) {
    const exists = fileStore.has(file)
    return exists
  },
  fileStatSync(file: string) {
    const f = fileStore.get(file)
    if (!f) {
      throw new Error()
    }

    return createMockStat(f) as any
  },
}
export const testLogger = new PZLogger({ id: 'test', level: LogLevel.DEBUG })

ctxCtrl.setDevModule('fs-helper', MockFSHelper)
ctxCtrl.bindingLogger(testLogger)
ctxCtrl.enableDevMode(true)

export const createRandomBuffer = (length = 4194304) => {
  const buffer = Buffer.allocUnsafeSlow(length)

  let i = 0
  while (i < length) {
    const n = (Math.random() * 256) << 0
    buffer.writeUInt8(n)
    i++
  }
  return buffer
}
export const equalBuffer = (buf1: Buffer, buf2: Buffer) => {
  if (buf1.length !== buf2.length) return false

  for (let i = 0; i < buf1.length; i++) {
    if (buf1[i] !== buf2[i]) return false
  }
  return true
}
export const assert = (value: any, message?: string) => {
  if (!value) {
    console.error(new Error(message))
  }
}
