export interface PZFileBase {
  readonly name: string
  readonly fullname: string
  readonly ext: string
  readonly pid: number
  readonly size: number
}
export interface PZFolder {
  readonly id: number
  readonly pid: number
  readonly name: string
  readonly fullname: string
}
export interface PZFilePacked extends PZFileBase {
  readonly fid: number
  readonly offset: number
  readonly originSize: number
}
export interface PZFileBuilding extends PZFileBase {
  readonly source: string
}

export interface PZReadOptions {
  buffer: Buffer
  offset: number
  position: number
  length: number
}
export interface PZReadResult {
  bytesRead: number
  buffer: Buffer
}
export interface PZReadableHandle {
  read: (options: PZReadOptions) => Promise<PZReadResult>
}
export interface PZWriteResult {
  bytesWritten: number
  buffer: Buffer
}
export interface PZWriteableHandle {
  write: (buffer: Buffer, offset: number, length: number, position: number) => Promise<PZWriteResult>
}
