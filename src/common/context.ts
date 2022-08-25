import { type PZLogger } from '../utils/logger'

interface PzRunningContext  {
  logger?: PZLogger
  devMode: boolean
}
const context: PzRunningContext = { devMode: false }

export const bindingLogger = (logger: PZLogger) => {
  context.logger = logger
}
export const enableDevMode = (enable: boolean) => {
  context.devMode = enable
}

export const getContext = () => {
  return {
    get logger () {
      return context.logger
    },
    get devMode () {
      return context.devMode
    }
  }
}