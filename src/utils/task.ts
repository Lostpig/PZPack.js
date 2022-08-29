import { errorCodes, PZError } from '../exceptions'
import { PZBehaviorSubject, waitObservable } from './subscription'

export interface TaskCompleteReport<T> {
  value?: T
  isCanceled: boolean
}
interface TaskContext<T> {
  canceler: AsyncCanceler
  subject: PZBehaviorSubject<T, T>
}
export interface CancelToken {
  readonly canceled: boolean
  onChange: (handler: () => void) => void
}

const store = new WeakMap<AsyncTask<any>, TaskContext<any>>()
class AsyncTask<T> {
  private getContext() {
    const context = store.get(this)
    if (!context) {
      throw new PZError(errorCodes.AsyncTaskNotFound)
    }
    return context as  TaskContext<T>
  }
  get canceled() {
    return this.getContext().canceler.canceled
  }
  observable () {
    return this.getContext().subject.toObservable()
  }
  cancel() {
    this.getContext().canceler.cancel()
  }
}
class AsyncCanceler {
  private value = false
  private handlers = new Set<() => void>()
  get canceled() {
    return this.value
  }
  cancel() {
    if (this.value !== true) {
      this.value = true
      this.handlers.forEach((h) => h())
    }
  }
  getToken() {
    const valueGetter = () => this.value
    const bindHandler = (handler: () => void) => this.handlers.add(handler)

    return {
      get canceled() {
        return valueGetter()
      },
      onChange(handler: () => void) {
        bindHandler(handler)
      },
    }
  }
  clear () {
    this.handlers.clear()
  }
}

const create = <T>(initState: T): [AsyncTask<T>, CancelToken] => {
  const subject = new PZBehaviorSubject<T, T>(initState)
  const canceler = new AsyncCanceler()
  const task = new AsyncTask<T>()

  const context: TaskContext<T> = {
    subject,
    canceler,
  }
  store.set(task, context)

  waitObservable(subject).finally(() => canceler.clear())
  const cancelToken = canceler.getToken()
  return [task, cancelToken]
}
const update = <T>(task: AsyncTask<T>, statePatch: Partial<T>) => {
  const context = store.get(task)
  if (context) {
    const oldState = context.subject.current
    const state = Object.assign({}, oldState, statePatch)
    context.subject.next(state)
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
    context.subject.complete(context.subject.current)
  }
}

export const taskManager = {
  create,
  update,
  throwError,
  complete,
}
export type { AsyncTask }
