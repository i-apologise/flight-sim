/* SharedWorker: pings all connected game tabs so background tabs keep net/sim alive */
const ports = new Set();
let timer = null;

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => {
    for (const p of ports) {
      try {
        p.postMessage({ type: 'tick', t: Date.now() });
      } catch (_) {
        ports.delete(p);
      }
    }
    if (ports.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }, 50);
}

self.onconnect = (e) => {
  const port = e.ports[0];
  ports.add(port);
  port.onmessage = (ev) => {
    if (ev.data?.type === 'bye') ports.delete(port);
  };
  port.start();
  ensureTimer();
  port.postMessage({ type: 'hello' });
};
