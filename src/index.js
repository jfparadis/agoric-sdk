/**
 * Create an EPromise class that supports eventual send (infix-bang) operations.
 * This is a class that extends the Promise class argument (which may be platform
 * Promises, or some other implementation).
 *
 * Based heavily on nanoq https://github.com/drses/nanoq/blob/master/src/nanoq.js
 *
 * Original spec for the infix-bang desugaring:
 * https://web.archive.org/web/20161026162206/http://wiki.ecmascript.org/doku.php?id=strawman:concurrency
 *
 * @param {typeof Promise} Promise Promise class to derive from
 * @returns {typeof EPromise} EPromise class
 */
export default function makeEPromiseClass(Promise) {
  /**
   * Reduce-like function to support iterable values mapped to Promise.resolve, and
   * combine them asynchronously.
   *
   * The combiner may be called in any order, and the collection is not necessarily
   * done iterating by the time it's called.
   *
   * The notable difference from reduce is that the combiner gets a reified
   * settled promise, and returns a combiner action (reject, resolve, continue).
   *
   * @param {*} initValue first value of result
   * @param {Iterable} iterable values to Promise.resolve
   * @param {Combiner} combiner synchronously reduce each item
   * @returns {Promise<*>}
   */
  function combinePromises(initValue, iterable, combiner) {
    let result = initValue;

    return new Promise(async (resolve, reject) => {
      // We start at 1 to prevent the iterator from resolving
      // the EPromise until the loop is complete and all items
      // have been reduced.
      let countDown = 1;
      let alreadySettled = false;

      function rejectOnce(e) {
        if (!alreadySettled) {
          alreadySettled = true;
          reject(e);
        }
      }

      function resolveOnce(value) {
        if (!alreadySettled) {
          alreadySettled = true;
          resolve(value);
        }
      }

      async function doReduce(mapped, index) {
        if (alreadySettled) {
          // Short-circuit out of here, since we already
          // rejected or resolved.
          return;
        }

        // Either update the result or throw an exception.
        if (index !== undefined) {
          const action = await combiner(result, mapped, index);
          switch (action.status) {
            case 'continue':
              // eslint-disable-next-line prefer-destructuring
              result = action.result;
              break;

            case 'rejected':
              rejectOnce(action.reason);
              break;

            case 'fulfilled':
              // Resolve the outer promise.
              result = action.value;
              resolveOnce(result);
              break;

            default:
              throw TypeError(`Not a valid combiner return value: ${action}`);
          }
        }

        // Check to see if we're the last outstanding combiner.
        countDown -= 1;
        if (countDown === 0) {
          // Resolve the outer promise.
          resolveOnce(result);
        }
      }

      try {
        let i = 0;
        for (const item of iterable) {
          const index = i;
          i += 1;

          // Say that we have one more to wait for.
          countDown += 1;

          /* eslint-disable-next-line no-use-before-define */
          Promise.resolve(item)
            .then(
              value => doReduce({ status: 'fulfilled', value }, index), // Successful resolve.
              reason => doReduce({ status: 'rejected', reason }, index), // Failed resolve.
            )
            .catch(rejectOnce);
        }

        // If we had no items or they all settled before the
        // loop ended, this will count down to zero and resolve
        // the result.
        await doReduce(undefined, undefined);
      } catch (e) {
        rejectOnce(e);
      }
    });
  }
  // A remoteRelay must additionally have an AWAIT_FAR method
  const localRelay = {
    GET(p, key) {
      return p.then(o => o[key]);
    },
    PUT(p, key, val) {
      return p.then(o => (o[key] = val));
    },
    DELETE(p, key) {
      return p.then(o => delete o[key]);
    },
    POST(p, optKey, args) {
      if (optKey === undefined || optKey === null) {
        return p.then(o => o(...args));
      }
      return p.then(o => o[optKey](...args));
    },
  };

  const relayToPromise = new WeakMap();
  const promiseToRelay = new WeakMap();

  function relay(p) {
    return promiseToRelay.get(p) || localRelay;
  }

  class EPromise extends Promise {
    static makeRemote(remoteRelay) {
      const promise = this.resolve(remoteRelay.AWAIT_FAR());
      relayToPromise.set(remoteRelay, promise);
      promiseToRelay.set(promise, remoteRelay);
      return promise;
    }

    static resolve(specimen) {
      return (
        relayToPromise.get(specimen) ||
        new EPromise(resolve => resolve(specimen))
      );
    }

    static reject(reason) {
      return new EPromise((_resolve, reject) => reject(reason));
    }

    get(key) {
      return relay(this).GET(this, key);
    }

    put(key, val) {
      return relay(this).PUT(this, key, val);
    }

    del(key) {
      return relay(this).DELETE(this, key);
    }

    post(optKey, args) {
      return relay(this).POST(this, optKey, args);
    }

    invoke(optKey, ...args) {
      return relay(this).POST(this, optKey, args);
    }

    fapply(args) {
      return relay(this).POST(this, undefined, args);
    }

    fcall(...args) {
      return relay(this).POST(this, undefined, args);
    }

    // ***********************************************************
    // The rest of these static methods ensure we use the correct
    // EPromise.resolve and EPromise.reject, no matter what the
    // implementation of the inherited Promise is.
    static all(iterable) {
      return combinePromises([], iterable, (res, item, index) => {
        if (item.status === 'rejected') {
          throw item.reason;
        }
        res[index] = item.value;
        return { status: 'continue', result: res };
      });
    }

    static allSettled(iterable) {
      return combinePromises([], iterable, (res, item, index) => {
        res[index] = item;
        return { status: 'continue', result: res };
      });
    }

    static race(iterable) {
      return combinePromises([], iterable, (_, item) => item);
    }
  }

  return EPromise;
}

/**
 * A reified fulfilled promise.
 * 
 * @typedef {Object} SettledFulfilled
 * @property {'fulfilled'} status
 * @property {*} [value]
 */

/**
 * A reified rejected promise.
 * 
 * @typedef {Object} SettledRejected
 * @property {'rejected'} status
 * @property {*} [reason]
 */

/**
 * A reified settled promise.
 * @typedef {SettledFulfilled | SettledRejected} SettledStatus
 */

/**
 * Tell combinePromises to continue with a new value for the result.
 *
 * @typedef {Object} CombinerContinue
 * @property {'continue'} status
 * @property {*} result
 */

/**
 * Return a new value based on the results of an item's mapped promise.
 *
 * @callback Combiner
 * @param {*} previousValue
 * @param {SettledStatus} currentValue
 * @param {number} currentIndex
 * @returns {CombinerContinue|SettledStatus} what to do next
 */
