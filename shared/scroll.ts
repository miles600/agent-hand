/** Wait for delayed wheel handling and subsequent scroll events, including nested scrollers. */
export function waitForScroll(target: EventTarget, quietMs = 150, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(quietTimer);
      clearTimeout(deadline);
      target.removeEventListener('scroll', onScroll, true);
      if (error) reject(error);
      else resolve();
    };
    const onScroll = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    };
    let quietTimer = setTimeout(finish, quietMs);
    const deadline = setTimeout(() => finish(new Error('scroll did not settle within 2000ms')), timeoutMs);
    target.addEventListener('scroll', onScroll, true);
  });
}
