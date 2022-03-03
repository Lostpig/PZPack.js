import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'

export const bytesToHex = (buf: Buffer) => {
  return buf.toString('hex').toUpperCase()
}

const checkDirExists = (dir: string) => {
  const dirExists = fs.existsSync(dir)
  if (dirExists) {
    const stats = fs.statSync(dir)
    if (!stats.isDirectory()) {
      throw new Error(`Path ${dir} is already exists and it's not a directory`)
    }
  }
  return dirExists
}
export const ensureDir = (dir: string) => {
  if (!checkDirExists(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
export const ensureEmptyDir = (dir: string) => {
  if (!checkDirExists(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  } else {
    const children = fs.readdirSync(dir)
    if (children && children.length > 0) {
      throw new Error(`Path ${dir} is already exists and not empty`)
    }
  }
}

export const fspEnsureOpenFile = async (file: string, flag: string = 'w+') => {
  let stats
  try {
    stats = await fsp.stat(file)
  } catch {}
  if (!(stats && stats.isFile())) {
    ensureDir(path.dirname(file))
  }
  return await fsp.open(file, flag)
}

export const fsReadAsync = (fd: number, buffer: Buffer, options: Required<fs.ReadSyncOptions>) => {
  return new Promise<number>((res, rej) => {
    fs.read(fd, buffer, options.offset, options.length, options.position, (err, bytesReaded) => {
      if (err) {
        rej(err)
      } else {
        res(bytesReaded)
      }
    })
  })
}
export const fsWriteAsync = (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
  return new Promise<number>((res, rej) => {
    fs.write(fd, buffer, offset, length, position, (err, bytesWritten) => {
      if (err) {
        rej(err)
      } else {
        res(bytesWritten)
      }
    })
  })
}
export const fsOpenAsync = (file: fs.PathLike, flags: fs.OpenMode) => {
  return new Promise<number>((res, rej) => {
    fs.open(file, flags, (err, fd) => {
      if (err) {
        rej(err)
      } else {
        res(fd)
      }
    })
  })
}
export const fsCloseAsync = (fd: number) => {
  return new Promise<void>((res, rej) => {
    fs.close(fd, (err) => {
      if (err) {
        rej(err)
      } else {
        res()
      }
    })
  })
}

export const wait = (ms: number) => {
  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise<void>((res) => {
    setTimeout(res, ms)
  })
}
export const nextTick = () => {
  return wait(0)
}
