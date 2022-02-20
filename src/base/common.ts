import { sha256Hex } from './hash'

export const compatibleVersions = [1, 2, 3]
export const currentVersion = 3
export const pzSign = 'PZPACK'
export const folderRootId = 10000

export const isCompatible = (version: number) => {
  return compatibleVersions.includes(version)
}

let signHash: string | undefined = undefined
export const getSignHash = () => {
  if (!signHash) {
    signHash = sha256Hex(pzSign)
  }
  return signHash
}

export type ProgressReporter<T> = (value: T) => void
