const { app, BrowserWindow, shell, session, Menu, protocol, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { net } = require('electron');

// ---------- Over-the-air game updates ----------
// The games live in one index.html. The app ships a bundled copy, and on every start it
// asks UPDATE_BASE/version.json whether a newer copy exists. A newer copy is downloaded,
// checked against its SHA-256, and used from the NEXT start. If the server is unreachable
// the app silently keeps using the cached or bundled copy.
const UPDATE_BASE = 'https://217.18.90.60/pc';
const BUNDLED_VERSION = Number(require('./package.json').contentVersion) || 0;

const updDir = () => path.join(app.getPath('userData'), 'update');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const gt = (a, b) => { // is version string a newer than b?  e.g. "1.2.0" > "1.1.2"
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
};

// Returns { html: Buffer, version: Number } - the cached update if valid, else the bundled file.
function loadGame() {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(updDir(), 'meta.json'), 'utf8'));
    const buf = fs.readFileSync(path.join(updDir(), 'index.html'));
    if (meta.shell === app.getVersion() &&      // cache was made for this exact app build
        meta.version > BUNDLED_VERSION &&       // and is newer than what we ship
        meta.sha256 === sha256(buf)) {          // and is not corrupted
      return { html: buf, version: meta.version };
    }
  } catch (e) { /* no usable cache */ }
  return { html: fs.readFileSync(path.join(__dirname, 'index.html')), version: BUNDLED_VERSION };
}

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await net.fetch(url, { signal: ctl.signal, cache: 'no-store' }); }
  finally { clearTimeout(t); }
}

async function checkForUpdate(currentVersion) {
  try {
    const r = await fetchWithTimeout(UPDATE_BASE + '/version.json', 8000);
    if (!r.ok) return;
    const v = await r.json();
    if (!v || !Number.isFinite(v.version) || !/^[0-9a-f]{64}$/.test(v.sha256 || '')) return;
    if (v.version <= currentVersion) return;                           // already up to date
    if (v.minShell && gt(v.minShell, app.getVersion())) return;        // needs a newer app build
    const f = await fetchWithTimeout(UPDATE_BASE + '/index.html?v=' + v.version, 120000);
    if (!f.ok) return;
    const buf = Buffer.from(await f.arrayBuffer());
    if (sha256(buf) !== v.sha256) return;                              // corrupted/incomplete download
    fs.mkdirSync(updDir(), { recursive: true });
    const tmp = path.join(updDir(), 'index.html.tmp');
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, path.join(updDir(), 'index.html'));
    fs.writeFileSync(path.join(updDir(), 'meta.json'),
      JSON.stringify({ version: v.version, sha256: v.sha256, shell: app.getVersion() }));
  } catch (e) { /* offline or server down: keep the current copy */ }
}

// Serve the game from a secure, standard origin (app://game) instead of file://.
// Games run inside blob: iframes, which do not load from a file:// origin.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 800, minHeight: 560,
    backgroundColor: '#0b1026',
    autoHideMenuBar: true,
    title: 'Game Box',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(null);
  win.loadURL('app://game/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type === 'keyDown' && i.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
}

process.on('uncaughtException', e => console.error(e));

app.whenReady().then(() => {
  const game = loadGame();
  protocol.handle('app', () => {
    return new Response(game.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) =>
    cb(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write'].includes(perm)));

  // Screen share (getDisplayMedia) is not built into Electron: show our own picker window.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    let finished = false;
    const finish = (src) => {
      if (finished) return;
      finished = true;
      try {
        if (src) {
          const streams = { video: src };
          if (request.audioRequested) streams.audio = 'loopback'; // system audio on Windows
          callback(streams);
        } else {
          try { callback(null); } catch (e) { callback({}); }
        }
      } catch (e) { /* request already cancelled */ }
    };

    desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false
    }).then(sources => {
      if (!sources.length) return finish(null);
      const items = sources.map(x => ({
        id: x.id, name: x.name, screen: x.id.startsWith('screen:'), img: x.thumbnail.toDataURL()
      }));
      const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const picker = new BrowserWindow({
        width: 820, height: 600, parent, modal: !!parent, autoHideMenuBar: true,
        backgroundColor: '#0b1026', title: 'Share screen',
        icon: path.join(__dirname, 'build', 'icon.ico'),
        webPreferences: { nodeIntegration: true, contextIsolation: false }
      });
      picker.setMenu(null);
      const html = `<!DOCTYPE html><meta charset="utf-8"><title>Share screen</title>
<style>body{margin:0;padding:16px;background:#0b1026;color:#fff;font-family:Segoe UI,Tahoma,sans-serif}
h2{margin:8px 0;font-size:15px;color:#e9c46a}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.c{background:#151c3d;border:2px solid transparent;border-radius:10px;padding:8px;cursor:pointer}
.c:hover{border-color:#e9c46a}.c img{width:100%;border-radius:6px;background:#000;display:block}
.c div{margin-top:6px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button{margin-top:16px;padding:8px 18px;border-radius:8px;border:0;background:#3a2230;color:#fff;cursor:pointer}</style>
<h2>Screens</h2><div class="g" id="s"></div><h2>Windows</h2><div class="g" id="w"></div>
<button id="x">Cancel</button>
<script>const {ipcRenderer}=require('electron');const items=${JSON.stringify(items).replace(/</g, '\\u003c')};
for(const it of items){const c=document.createElement('div');c.className='c';const i=document.createElement('img');i.src=it.img;
const n=document.createElement('div');n.textContent=it.name;c.append(i,n);c.onclick=()=>ipcRenderer.send('gb-pick',it.id);
document.getElementById(it.screen?'s':'w').append(c);}
document.getElementById('x').onclick=()=>ipcRenderer.send('gb-pick',null);</script>`;
      const onPick = (e, id) => {
        if (e.sender !== picker.webContents) return;
        ipcMain.removeListener('gb-pick', onPick);
        finish(id ? sources.find(x => x.id === id) : null);
        if (!picker.isDestroyed()) picker.close();
      };
      ipcMain.on('gb-pick', onPick);
      picker.on('closed', () => { ipcMain.removeListener('gb-pick', onPick); finish(null); });
      picker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    }).catch(() => finish(null));
  });
  createWindow();
  checkForUpdate(game.version);
});
app.on('window-all-closed', () => app.quit());
