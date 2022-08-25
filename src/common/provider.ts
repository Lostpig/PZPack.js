import type { FileHandle } from 'fs/promises'
import type { Stats } from 'fs'
import * as fsh from '../utils/fs-helper'
import { getContext } from './context'

export interface FSHelperModule {
  dirExists: (dir: string) => Promise<boolean>
  fileExists: (file: string) => Promise<boolean>
  ensureDir: (dir: string) => Promise<string | undefined>
  ensureFile: (file: string, flag?: string) => Promise<FileHandle>
  renameFile: (oldPath: string, newPath: string) => Promise<void>
  removeFile: (oldPath: string) => Promise<void>
  fileExistsSync: (file: string) => boolean
  fileStatSync: (file: string) => Stats
}
const defaultFSHelper: FSHelperModule = {
  dirExists: fsh.dirExists,
  fileExists: fsh.fileExists,
  ensureDir: fsh.ensureDir,
  ensureFile: fsh.ensureFile,
  renameFile: fsh.renameFile,
  removeFile: fsh.removeFile,
  fileExistsSync: fsh.fileExistsSync,
  fileStatSync: fsh.fileStatSync
}

type ProvideModules = {
  'fs-helper': FSHelperModule
}
type ProvideModuleName = keyof ProvideModules
type Provider = {
  get: <M extends ProvideModuleName>(module: M) => ProvideModules[M]
}

const ctx = getContext()

const providerStore: ProvideModules = {
  'fs-helper': defaultFSHelper,
}
const devModeStore: Partial<ProvideModules> = {} 

export const provider: Provider = {
  get(module: ProvideModuleName) {
    let result
    if (ctx.devMode) {
      result = devModeStore[module] ?? providerStore[module]
    } else {
      result = providerStore[module]
    }

    return result
  },
}
export const setDevModule = <M extends ProvideModuleName>(name: M, module: ProvideModules[M]) => {
  devModeStore[name] = module
}
