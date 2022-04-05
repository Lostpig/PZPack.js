import * as path from 'path'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import { sha256, sha256Hex } from './base/hash'
import { bytesToHex } from './base/utils'

const scanDirectory = async (dir: string) => {
  const dirs = [dir]
  const files: string[] = []

  while (dirs.length > 0) {
    const d = dirs.pop()!
    const list = await fsp.readdir(d)
    for (const f of list) {
      const fullname = path.join(d, f)
      const stats = await fsp.stat(fullname)
      if (stats.isDirectory()) {
        dirs.push(fullname)
      }
      if (stats.isFile()) {
        files.push(fullname)
      }
    }
  }

  return files
}
const scanDirectorySync = (dir: string) => {
  const dirs = [dir]
  const files: string[] = []

  while (dirs.length > 0) {
    const d = dirs.pop()!
    const list = fs.readdirSync(d)
    for (const f of list) {
      const fullname = path.join(d, f)
      const stats = fs.statSync(fullname)
      if (stats.isDirectory()) {
        dirs.push(fullname)
      }
      if (stats.isFile()) {
        files.push(fullname)
      }
    }
  }

  return files
}

export const PZHelper = {
  scanDirectory,
  scanDirectorySync,
  sha256,
  sha256Hex,
  bytesToHex
}