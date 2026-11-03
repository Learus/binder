// Desktop wrapper: runs the same local API the dev server uses, serves the
// built page, and shows it in a window. Binders and the image cache live in
// the user's app-data folder, so the app can sit anywhere (even read-only).
import { app, BrowserWindow, Menu, shell } from 'electron';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { middleware, setDataDir } from '../server/api';

const PREFERRED_PORT = 47321;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(root: string, req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = path.join(root, rel || 'index.html');
  if (!file.startsWith(root)) {
    res.statusCode = 403;
    return res.end();
  }
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await fs.readFile(file);
    res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}

/** Listen on the preferred port so the page origin (and its saved settings) stays the same between runs. */
function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') return reject(err);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    server.listen(PREFERRED_PORT, '127.0.0.1', () => resolve(PREFERRED_PORT));
  });
}

async function start() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  setDataDir(dataDir);
  const api = middleware();
  const root = path.join(app.getAppPath(), 'dist');
  const server = http.createServer((req, res) => api(req, res, () => void serveStatic(root, req, res)));
  const port = await listen(server);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0c0a08',
    title: 'Card Binder',
    autoHideMenuBar: true,
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'Open data folder', click: () => void shell.openPath(dataDir) },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }],
      },
    ]),
  );

  await fs.mkdir(dataDir, { recursive: true });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

// Without a usable GPU, let WebGL fall back to software rendering rather
// than leaving the 3D view blank.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}
