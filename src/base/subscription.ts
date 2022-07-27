import { logger } from './logger'

export type Subscription = {
  closed: boolean
  unsubscribe: () => void
}
export type SubjectHandle<T> = {
  next?: (param: T) => void
  error?: (e: Error) => void
  complete?: () => void
  subscription: Subscription
}
export interface PZObservable<T> {
  closed: boolean
  status: 'active' | 'error' | 'complete'
  subscribe: (next: (param: T) => void, err?: (e: Error) => void, complete?: () => void) => Subscription
}
export interface PZBehaviorObservable<T> extends PZObservable<T> {
  readonly current: T
}

const closedUnsubscribeFunc = () => {
  logger.warning('this subscription is already closed')
}
export class PZSubject<T> implements PZObservable<T> {
  handles = new Map<symbol, SubjectHandle<T>>()
  get closed() {
    return this.status != 'active'
  }
  status: 'active' | 'error' | 'complete' = 'active'

  private addHandle(symbol: symbol, handle: SubjectHandle<T>) {
    this.handles.set(symbol, handle)
  }
  private removeHandle(symbol: symbol) {
    const handle = this.handles.get(symbol)
    if (handle) {
      this.handles.delete(symbol)

      handle.subscription.closed = true
      handle.subscription.unsubscribe = closedUnsubscribeFunc
    }
  }
  private innerError?: Error

  next(param: T) {
    for (const handle of this.handles.values()) {
      handle.next?.(param)
    }
  }
  complete() {
    for (const handle of this.handles.values()) {
      handle.complete?.()
      handle.subscription.closed = true
      handle.subscription.unsubscribe = closedUnsubscribeFunc
    }

    this.handles.clear()
    this.status = 'complete'
  }
  error(err: Error) {
    for (const handle of this.handles.values()) {
      handle.error?.(err)
      handle.subscription.closed = true
      handle.subscription.unsubscribe = closedUnsubscribeFunc
    }

    this.handles.clear()
    this.status = 'error'
    this.innerError = err
  }

  subscribe(next?: (param: T) => void, error?: (e: Error) => void, complete?: () => void) {
    if (this.closed) {
      if (this.status == 'error' && error) {
        error(this.innerError || new Error())
      }
      if (this.status == 'complete' && complete) {
        complete()
      }

      return {
        closed: true,
        unsubscribe: closedUnsubscribeFunc,
      }
    }

    const s = Symbol()
    const subscription = {
      closed: false,
      unsubscribe: () => {
        this.removeHandle(s)
      },
    }
    const handle = { next, error, complete, subscription }
    this.addHandle(s, handle)
    return subscription
  }
  asObservable() {
    return this as PZObservable<T>
  }
}
export class PZBehaviorSubject<T> extends PZSubject<T> {
  private _currentValue: T
  private _currentError?: Error

  get current() {
    return this._currentValue
  }
  constructor(initValue: T) {
    super()
    this._currentValue = initValue
  }

  next(param: T): void {
    if (super.status === 'active') {
      this._currentValue = param
    }
    super.next(param)
  }
  subscribe(next?: (param: T) => void, error?: (e: Error) => void, complete?: () => void) {
    const res = super.subscribe(next, error, complete)
    if (super.status === 'active') {
      next?.(this.current)
    }
    return res
  }
  asObservable(): PZBehaviorObservable<T> {
    return this
  }
}

export const waitObservable = (observable: PZObservable<unknown>) => {
  return new Promise<void>((res, rej) => {
    observable.subscribe(() => {}, rej, res)
  })
}
