export type Subscription = {
  closed: boolean
  unsubscribe: () => void
}
type completeFunc<R = undefined> = (result: NonNullable<R>) => void
export type SubjectHandle<T, R = undefined> = {
  next?: (param: T) => void
  error?: (e: Error) => void
  complete?: completeFunc<R>
  subscription: Subscription
}
export interface PZObservable<T, R = undefined> {
  closed: boolean
  status: 'active' | 'error' | 'complete'
  subscribe: (next?: (param: T) => void, err?: (e: Error) => void, complete?: completeFunc<R>) => Subscription
}
export interface PZBehaviorObservable<T, R = undefined> extends PZObservable<T, R> {
  readonly current: T
}

const closedUnsubscribeFunc = () => {}
type NextFuncWrapper<T> = (fn: (param: T) => void) => (param: T) => void
const createPipedObservable = <T, R, O extends PZObservable<T, R> = PZObservable<T, R>>(origin: O, wrapper?: NextFuncWrapper<T>) => {
  const originSubscribe = origin.subscribe
  const wrappedSubscribe = (next?: (param: T) => void, error?: (e: Error) => void, complete?: completeFunc<R>) => {
    const wrappedNext = next && wrapper ? wrapper(next) : next
    return originSubscribe.call(origin, wrappedNext, error, complete)
  }

  return new Proxy(origin, {
    get: (target, prop, receiver) => {
      if (prop === 'subscribe') return wrappedSubscribe
      else return Reflect.get(target, prop, receiver)
    }
  })
}

export class PZSubject<T, R = undefined> implements PZObservable<T, R> {
  private handles = new Map<symbol, SubjectHandle<T, R>>()
  get closed() {
    return this.status != 'active'
  }
  status: 'active' | 'error' | 'complete' = 'active'

  private addHandle(symbol: symbol, handle: SubjectHandle<T, R>) {
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
  private innerResult?: R

  next(param: T) {
    for (const handle of this.handles.values()) {
      handle.next?.(param)
    }
  }
  complete(result: R extends undefined ? void : R): void {
    this.innerResult = (result as R) ?? undefined
    for (const handle of this.handles.values()) {
      handle.complete?.(this.innerResult!)
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

  subscribe(next?: (param: T) => void, error?: (e: Error) => void, complete?: completeFunc<R>) {
    if (this.closed) {
      if (this.status == 'error' && error) {
        error(this.innerError || new Error())
      }
      if (this.status == 'complete' && complete) {
        complete(this.innerResult!)
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
    return createPipedObservable<T, R>(this)
  }
}
export class PZBehaviorSubject<T, R = undefined> extends PZSubject<T, R> implements PZBehaviorObservable<T, R> {
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
  subscribe(next?: (param: T) => void, error?: (e: Error) => void, complete?: completeFunc<R>) {
    const res = super.subscribe(next, error, complete)
    if (!this.closed) next?.(this.current)
    return res
  }
  toObservable() {
    return createPipedObservable<T, R, PZBehaviorObservable<T, R>>(this)
  }
}
export const waitObservable = <T, R>(observable: PZObservable<T, R>) => {
  return new Promise<void>((res, rej) => {
    const subscrition = observable.subscribe(
      undefined,
      (e) => {
        subscrition.unsubscribe()
        rej(e)
      },
      () => {
        subscrition.unsubscribe()
        res()
      },
    )
  })
}

export const frequencyPipe = <T, R, O extends PZObservable<T, R>>(observable: O, interval: number) => {
  const wrapper: NextFuncWrapper<T> = (fn) => {
    let last = 0
    return (p: T) => {
      const now = Date.now()
      if (now - last > interval) {
        last = now
        fn(p)
      }
    }
  }
  return createPipedObservable(observable, wrapper)
}
