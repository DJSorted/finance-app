// Registers the service worker so the app can be installed on phones and PCs,
// and offers a reload when a new version has been deployed while a page is open.
const CHECK_KEY = 'swUpdateCheck';
const CHECK_MS = 10 * 60 * 1000;

function showUpdateBar() {
  if (document.getElementById('update-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'update-bar';
  bar.className = 'update-bar';
  bar.innerHTML = '<span>New version available</span>'
    + '<button type="button" class="btn btn-primary btn-sm">Reload</button>'
    + '<button type="button" class="update-later" title="Later" aria-label="Later">×</button>';
  const [reload, later] = bar.querySelectorAll('button');
  reload.addEventListener('click', () => location.reload());
  later.addEventListener('click', () => bar.remove());
  document.body.append(bar);
}

// Asks the browser to look for a new sw.js, at most every 10 minutes
function maybeCheck(reg) {
  if (!navigator.onLine) return;
  let last = 0;
  try { last = Number(localStorage.getItem(CHECK_KEY) || 0); } catch (e) { /* ignore */ }
  if (Date.now() - last < CHECK_MS) return;
  try { localStorage.setItem(CHECK_KEY, String(Date.now())); } catch (e) { /* ignore */ }
  reg.update().catch(() => {});
}

if ('serviceWorker' in navigator) {
  // A page already controlled by a worker that later gets a new one = a new deploy
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) showUpdateBar(); });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        maybeCheck(reg);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') maybeCheck(reg); });
        setInterval(() => { if (document.visibilityState === 'visible') maybeCheck(reg); }, CHECK_MS);
      })
      .catch((err) => console.warn('Service worker not registered:', err));
  });
}
