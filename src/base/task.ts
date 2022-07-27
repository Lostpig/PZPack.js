import { performance } from 'node:perf_hooks'
import { PZBehaviorSubject } from './subscription'

export interface TaskCompleteReport<T> {
  value?: T
  isCanceled: boolean
}
interface TaskContext<T> {
  frequency: number
  lastReportTime: number
  canceler: AsyncCanceler
  subject: PZBehaviorSubject<T>
}
export interface CancelToken {
  readonly canceled: boolean
  onChange: (handler: () => void) => void
}

const store = new WeakMap<AsyncTask<any>, TaskContext<any>>()
class AsyncTask<T> {
  private getContext () {
    const context = store.get(this)
    if (!context) {
      throw new Error('AsyncTask reference not available')
    }
    return context
  }

  get canceled () {
    return this.getContext().canceler.canceled
  }
  subscribe(next: (param: T) => void, error?: (e: Error) => void, complete?: () => void) {
    return this.getContext().subject.subscribe(next, error, complete)
  }
  cancel() {
    this.getContext().canceler.cancel()
  }
}
class AsyncCanceler {
  private value = false
  private handlers = new Set<() => void>()
  get canceled () {
    return this.value
  }
  cancel () {
    if (this.value !== true) {
      this.value = true
      this.handlers.forEach(h => h())
    }
  }
  getToken () {
    const valueGetter = () => this.value
    const bindHandler = (handler: () => void) => this.handlers.add(handler)

    return {
      get canceled () {
        return valueGetter()
      },
      onChange (handler: () => void) {
        bindHandler(handler)
      }
    }
  }
}

const create = <T>(initState: T, frequency: number = 0): [AsyncTask<T>, CancelToken] => {
  const subject = new PZBehaviorSubject(initState)
  const canceler = new AsyncCanceler()
  const task = new AsyncTask<T>()

  const context: TaskContext<T> = {
    frequency,
    lastReportTime: 0,
    subject,
    canceler
  }
  store.set(task, context)

  const cancelToken = canceler.getToken()
  return [task, cancelToken]
}
const update = <T>(task: AsyncTask<T>, state: T) => {
  const context = store.get(task)
  if (context) {
    const now = performance.now()
    if (now - context.lastReportTime < context.frequency) return

    context.subject.next(state)
    context.lastReportTime = now
  }
}
const throwError = <T>(task: AsyncTask<T>, err: Error) => {
  const context = store.get(task)
  if (context) {
    context.subject.error(err)
  }
}
const complete = <T>(task: AsyncTask<T>) => {
  const context = store.get(task)
  if (context) {
    context.subject.complete()
  }
}

export const taskManager = {
  create,
  update,
  throwError,
  complete,
}

export type { AsyncTask }
