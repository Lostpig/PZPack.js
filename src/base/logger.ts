import { default as dayjs } from 'dayjs'
import { fspEnsureOpenFile } from './utils'
import { default as chalk, type Chalk } from 'chalk'

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
  SILENT = 4,
}
const levelPrefix: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '[DEBUG]',
  [LogLevel.INFO]: '[INFO]',
  [LogLevel.WARNING]: '[WARNING]',
  [LogLevel.ERROR]: '[ERROR]',
  [LogLevel.SILENT]: '[SILENT]',
}
const timePrefix = {
  get now() {
    return `[${dayjs().format('YYYY-MM-DD HH:mm:ss.SSS')}]`
  },
}
const levelColors: Record<LogLevel, Chalk> = {
  [LogLevel.DEBUG]: chalk.cyanBright,
  [LogLevel.INFO]: chalk.white,
  [LogLevel.WARNING]: chalk.hex('#FFAA03'),
  [LogLevel.ERROR]: chalk.red,
  [LogLevel.SILENT]: chalk.black.bgRed,
}

export class PZLogger {
  consoleLevel: LogLevel = LogLevel.DEBUG
  fileLevel: LogLevel = LogLevel.WARNING
  private filePath?: string
  private id: string = ''
  private get idPrefix() {
    return this.id ? `<${this.id}>` : ''
  }

  private log(level: LogLevel, ...message: string[]) {
    if (level < this.consoleLevel && level < this.fileLevel) return

    const text = [this.idPrefix, ...message].join(' ')
    const prefix = [timePrefix.now, levelPrefix[level]].join('')
    this.consoleLog(level, prefix, text)
    this.fileLog(level, prefix, text)
  }
  private consoleLog(level: LogLevel, prefix: string, text: string) {
    if (level >= this.consoleLevel) {
      const data = prefix + ' ' + levelColors[level](text)
      console.log(data)
    }
  }

  private fileLogging: boolean = false
  private fileLogQueue: string[] = []
  private fileLog(level: LogLevel, prefix: string, text: string) {
    if (level >= this.fileLevel && this.filePath) {
      const data = prefix + ' ' + text + '\n'
      this.fileLogQueue.push(data)
      this.excuteFileLog()
    }
  }
  private async excuteFileLog() {
    if (this.fileLogging || !this.filePath) return

    this.fileLogging = true
    const handle = await fspEnsureOpenFile(this.filePath, 'a')
    let text: string | undefined
    while ((text = this.fileLogQueue.shift()) !== undefined) {
      await handle.write(text, undefined, 'utf8')
    }
    await handle.close()
    this.fileLogging = false
  }

  get logFileName() {
    return this.filePath
  }

  constructor(id?: string) {
    this.id = id ?? ''
  }

  setID(id: string) {
    this.id = id
  }
  enableFileLog(file: string | false) {
    if (file === false) {
      this.filePath = undefined
      return
    }

    this.filePath = file
  }

  debug(...message: string[]) {
    return this.log(LogLevel.DEBUG, ...message)
  }
  info(...message: string[]) {
    return this.log(LogLevel.INFO, ...message)
  }
  warning(...message: string[]) {
    return this.log(LogLevel.WARNING, ...message)
  }
  error(...message: string[]) {
    return this.log(LogLevel.ERROR, ...message)
  }
  errorStack(error: any) {
    if (!(error instanceof Error)) {
      this.error(String.toString.apply(error))
      return
    }

    this.error(error.message)
    if (error.stack) {
      this.consoleLog(LogLevel.ERROR, '[Error stack]', error.stack)
      this.fileLog(LogLevel.ERROR, '[Error stack]', error.stack)
    }
  }
}

export const logger = new PZLogger('PZPack')
