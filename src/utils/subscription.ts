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
  subscribe: (next?: (param: T) => void, err?: (e: Error) => void, complete?: () => void) => Subscription
}
export interface PZBehaviorObservable<T> extends PZObservable<T> {
  readonly current: T
}

const closedUnsubscribeFunc = () => {}
type SubscribeWrapper<T> = (fn: (param: T) => void) => (param: T) => void
class PZObserver<T, R extends PZObservable<T>> implements PZBehaviorObservable<T> {
  private innerObservable: R
  private wrapper?: SubscribeWrapper<T>
  constructor (innerObservable: R, subscribeWrapper?: SubscribeWrapper<T>) {
    this.innerObservable = innerObservable
    this.wrapper = subscribeWrapper
  }
  get status () {
    return this.innerObservable.status
  }
  get closed () {
    return this.innerObservable.closed
  }
  get current () {
    return (this.innerObservable as never as PZBehaviorObservable<T>).current
  }

  subscribe(next?: (param: T) => void, error?: (e: Error) => void, complete?: () => void) {
    const wrappedNext = (next && this.wrapper) ? this.wrapper(next) : next
    const res = this.innerObservable.subscribe(wrappedNext, error, complete)
    return res
  }
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
  toObservable() {
    return new PZObserver(this) as PZObservable<T>
  }
}
export class PZBehaviorSubject<T> extends PZSubject<T> {
  private _currentValue: T

  get current() {
    return this._currentValue
  }
  constructor(initValue: T) {
    super()
    this._currentValue = initValue
  }

  next(param: T): void {
    if (!this.closed) this._currentValue = param
    super.next(param)
  }
  subscribe(next?: (param: T) => void, error?: (e: Error) => void, complete?: () => void) {
    const res = super.subscribe(next, error, complete)
    if (!this.closed) next?.(this.current)
    return res
  }
  toObservable() {
    return new PZObserver(this) as PZBehaviorObservable<T>
  }
}
export const waitObservable = (observable: PZObservable<unknown>) => {
  return new Promise<void>((res, rej) => {
    const subscrition = observable.subscribe(undefined, (e) => {
      subscrition.unsubscribe()
      rej(e)
    }, () => {
      subscrition.unsubscribe()
      res()
    })
  })
}
export const frequencyPipe = <T, O extends PZObservable<T>>(observable: O, interval: number) => {
  const wrapper: SubscribeWrapper<T> = (fn) => {
    let last = 0
    return (p: T) => {
      const now = Date.now()
      if (now - last > interval) {
        last = now
        fn(p)
      }
    }
  }
  return new PZObserver(observable, wrapper) as never as O
}