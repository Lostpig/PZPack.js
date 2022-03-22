import { performance } from 'node:perf_hooks'
import type { ProgressReporter } from './common'

export interface TaskCompleteReport<T> {
  value?: T
  isCanceled: boolean
}
interface TaskRefs<T> {
  success: (completeReport: TaskCompleteReport<T>) => void
  error: (e?: Error) => void
  canceled: boolean
  completed: boolean
}
interface TaskContext<T> {
  frequency: number
  lastReportTime: number
  reporters: Set<ProgressReporter<T>>
  refs: TaskRefs<T>
}
export interface CancelToken {
  readonly value: boolean
}

const store = new WeakMap<AsyncTask<unknown>, TaskContext<unknown>>()

const addReporter = <T>(task: AsyncTask<T>, reporter: ProgressReporter<T>) => {
  const context = store.get(task) as TaskContext<T>
  if (context) {
    context.reporters.add(reporter)
  }
}
const removeReporter = <T>(task: AsyncTask<T>, reporter: ProgressReporter<T>) => {
  const context = store.get(task) as TaskContext<T>
  if (context) {
    context.reporters.delete(reporter)
  }
}
const cancelTask = <T>(task: AsyncTask<T>) => {
  const context = store.get(task) as TaskContext<T>
  if (context) {
    context.refs.canceled = true
  }
}

class AsyncTask<T> {
  readonly complete: Promise<TaskCompleteReport<T>>
  constructor(competePromise: Promise<TaskCompleteReport<T>>) {
    this.complete = competePromise
  }

  addReporter(reporter: ProgressReporter<T>) {
    addReporter(this, reporter)
  }
  removeReporter(reporter: ProgressReporter<T>) {
    removeReporter(this, reporter)
  }
  cancel() {
    cancelTask(this)
  }
}

const create = <T>(frequency: number = 0): [AsyncTask<T>, CancelToken] => {
  const refs = { canceled: false, completed: false } as TaskRefs<T>
  const completePromise = new Promise<TaskCompleteReport<T>>((res, rej) => {
    refs.success = res
    refs.error = rej
  })

  const context: TaskContext<T> = {
    frequency,
    lastReportTime: 0,
    reporters: new Set<ProgressReporter<T>>(),
    refs,
  }

  const task = new AsyncTask<T>(completePromise)
  store.set(task, context as TaskContext<unknown>)

  const cancelToken = {
    get value() {
      return context.refs.canceled
    },
  }

  return [task, cancelToken]
}
const postReport = <T>(task: AsyncTask<T>, value: T) => {
  const context = store.get(task) as TaskContext<T>
  if (context) {
    const now = performance.now()
    if (now - context.lastReportTime < context.frequency) return

    context.reporters.forEach((p) => p(value))
    context.lastReportTime = now
  }
}
const throwError = <T>(task: AsyncTask<T>, err?: Error) => {
  const context = store.get(task) as TaskContext<T>
  if (context && !context.refs.completed) {
    context.refs.error(err)
    context.refs.completed = true
  }
}
const complete = <T>(task: AsyncTask<T>, value?: T) => {
  const context = store.get(task) as TaskContext<T>
  if (context && !context.refs.completed) {
    context.refs.success({
      value,
      isCanceled: context.refs.canceled,
    })
    context.refs.completed = true
  }
}

export const taskManager = {
  create,
  postReport,
  throwError,
  complete,
}

export type { AsyncTask }
