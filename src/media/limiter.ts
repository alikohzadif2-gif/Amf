/** Runs at most `limit` async jobs at once; the rest wait in order. */
export function createLimiter(limit: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (running >= limit) return;
    const start = queue.shift();
    if (start) start();
  };
  return function run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        running += 1;
        job()
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            next();
          });
      });
      next();
    });
  };
}
