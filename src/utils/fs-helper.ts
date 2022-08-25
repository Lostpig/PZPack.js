import * as fsp from 'fs/promises'
import * as fs from 'fs'
import * as path from 'path'
import { PZError,  errorCodes } from '../exceptions'

export const dirExists = async (dir: string) => {
  try {
    const stat = await fsp.stat(dir)
    if (!stat.isDirectory()) {
      throw new PZError(errorCodes.PathAlreadyExists, { path: dir })
    }
    return true
  } catch {
    return false
  }
}
export const fileExists = async (file: string) => {
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile()) {
      throw new PZError(errorCodes.PathAlreadyExists, { path: file })
    }
    return true
  } catch {
    return false
  }
}
export const fileStatSync = (file: string) => {
  return fs.statSync(file)
}
export const fileExistsSync = (file: string) => {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) {
      throw new PZError(errorCodes.PathAlreadyExists, { path: file })
    }
    return true
  } catch {
    return false
  }
}

export const ensureDir = async (dir: string) => {
  const exists = await dirExists(dir)
  if (!exists) {
    return await fsp.mkdir(dir, { recursive: true })
  }
  return dir
}
export const ensureFile = async (file: string, flag: string = 'w+') => {
  const exists = await fileExists(file)
  if (!exists) {
    await ensureDir(path.dirname(file))
  }
  return await fsp.open(file, flag)
}

export const renameFile = async (oldPath: string, newPath: string) => {
  return await fsp.rename(oldPath, newPath)
}
export const removeFile = async (oldPath: string) => {
  return await fsp.rm(oldPath)
}