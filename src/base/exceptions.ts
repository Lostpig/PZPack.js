abstract class PZError extends Error {
  public abstract readonly exMsg: string
}

export class NotSupportedVersionError extends PZError {
  readonly exMsg = 'EX_NotSupportedVersion'
}
export class NotSupportedFileTypeError extends PZError {
  readonly exMsg = 'EX_NotSupportedFileType'
}
export class IncorrectPasswordError extends PZError {
  readonly exMsg = 'EX_IncorrectPassword'
}
export class FileAlreadyExistsError extends PZError {
  readonly exMsg = 'EX_FileAlreadyExists'
}
