export const errorCodes = {
  FolderNotFound: 'EX_FolderNotFound',
  DuplicateName: 'EX_DuplicateName',
  FileNotFound: 'EX_FileNotFound',
  PathAlreadyExists: 'EX_PathAlreadyExists',
  ParameterInvaild: 'EX_ParameterInvalid',
  AsyncTaskNotFound: 'EX_AsyncTaskNotFound',
  IndexBuilderEmpty: 'EX_IndexBuilderEmpty',
  NotSupportVersion: 'EX_NotSupportVersion',
  NotSupportFile: 'EX_NotSupportFile',
  IncorrectPassword: 'EX_IncorrectPassword',
  FileSizeCheckFailed: 'EX_FileSizeCheckFailed'
}
export class PZError extends Error {
  readonly __pzerror__ = true
  readonly errorCode: string
  readonly params?: Record<string, string | number>
  constructor(errorCode: string, params?: Record<string, string | number>, message?: string) {
    super(message)

    this.errorCode = errorCode
    this.params = params
  }
}
export const isPZError = (err: Error): err is PZError => {
  if ((err as never as PZError)?.__pzerror__ === true) return true
  return false
}