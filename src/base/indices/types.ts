export interface PZFileBase {
  readonly name: string
  readonly fullname: string
  readonly pid: number
  readonly size: number
}
export interface PZFilePacked extends PZFileBase {
  readonly offset: number
}
export interface PZFileBuilding extends PZFileBase {
  readonly source: string
}
export interface PZFolder {
  readonly id: number
  readonly pid: number
  readonly name: string
  readonly fullname: string
}
export interface PZFolderChildren<FT extends PZFileBase> {
  files: FT[]
  folders: PZFolder[]
}