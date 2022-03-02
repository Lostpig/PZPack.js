import { Dayjs } from 'dayjs'
import * as fsp from 'fs/promises'

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
  SILENT = 4
}
const levelPrefix: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '[DEBUG]',
  [LogLevel.INFO]: '[INFO]',
  [LogLevel.WARNING]: '[WARING]',
  [LogLevel.ERROR]: '[ERROR]',
  [LogLevel.SILENT]: '[SILENT]',
}
const timePrefix = {
  get now () {
    return (new Dayjs()).format('[YYYY-MM-DD HH:mm:ss.SSS]')
  } 
}

export class PZLogger {
  consoleLevel: LogLevel = LogLevel.DEBUG
  fileLevel: LogLevel = LogLevel.WARNING
  filePath?: string

  private log(level: LogLevel, ...message: string[]) {
    if (level < this.consoleLevel && level < this.fileLevel) return

    const text = [timePrefix.now, levelPrefix[level], ...message].join(' ')
    this.consoleLog(level, text)
    this.fileLog(level, text)
  }
  private consoleLog (level: LogLevel, text: string) {
    if (level >= this.consoleLevel) {
      console.log(text)
    }
  }

  private fileLogging: boolean = false
  private fileLogQueue: string[] = []
  private fileLog (level: LogLevel, text: string) {
    if (level >= this.fileLevel && this.filePath) {
      this.fileLogQueue.push(text)
      this.excuteFileLog()
    }
  }
  private async excuteFileLog() {
    if (this.fileLogging || !this.filePath) return

    this.fileLogging = true
    const handle = await fsp.open(this.filePath, 'w')
    let text: string | undefined
    while ((text = this.fileLogQueue.shift()) !== undefined) {
      await handle.write(text, undefined, 'utf8')
    }
    await handle.close()
    this.fileLogging = false
  }

  enableFileLog (file: string | false) {
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
  errorStack (error: Error) {
    this.log(LogLevel.ERROR, error.message)
    if (error.stack) {
      this.consoleLog(LogLevel.ERROR, error.stack)
      this.fileLog(LogLevel.ERROR, error.stack)
    }
  }
}

export const logger = new PZLogger()