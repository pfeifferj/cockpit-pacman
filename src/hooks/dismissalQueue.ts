const tails = new WeakMap<object, Promise<void>>();

// A remounted view must wait for writes admitted by the previous instance.
export function queueDismissal<T>(resource: object, operation: () => Promise<T>): Promise<T> {
  const result = (tails.get(resource) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => {}, () => {});
  tails.set(resource, tail);
  void tail.then(() => {
    if (tails.get(resource) === tail) tails.delete(resource);
  });
  return result;
}
