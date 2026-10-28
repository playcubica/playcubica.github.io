import './style.css';
import { GameClient, type ClientStatus } from './client/GameClient';
import { createLocalPair } from './net/LocalTransport';
import { GameServer } from './server/GameServer';
import { WorkerChunkGenerator } from './server/WorkerChunkGenerator';
import { DEFAULT_VIEW_DISTANCE } from './shared/constants';
import type { ClientMsg, ServerMsg } from './shared/protocol/messages';
import { randomSeed, seedFromString } from './shared/rng';

// Stage 1 boot: single player only. The page hosts a GameServer and connects its
// own GameClient to it over an in-memory transport. URL options:
//   ?seed=<number|text>  world seed     ?vd=<2..16>  view distance in chunks

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
const seedParam = params.get('seed');
const seed = seedParam ? seedFromString(seedParam) : randomSeed();
const viewDistance = Math.max(2, Math.min(16, Number(params.get('vd')) || DEFAULT_VIEW_DISTANCE));

const overlay = document.createElement('div');
overlay.className = 'overlay';
overlay.dir = 'rtl';
app.appendChild(overlay);
const crosshair = document.createElement('div');
crosshair.className = 'crosshair';
app.appendChild(crosshair);

function showOverlay(html: string): void {
  overlay.innerHTML = html;
  overlay.style.display = '';
}

const HELP = `
  <h1>Cubica</h1>
  <p class="big">לחצו כדי לשחק</p>
  <table class="keys">
    <tr><td>W A S D</td><td>תנועה</td></tr>
    <tr><td>עכבר</td><td>הסתכלות</td></tr>
    <tr><td>Space / Shift</td><td>למעלה / למטה (מצב טיסה, שלב 1)</td></tr>
    <tr><td>Ctrl</td><td>טיסה מהירה</td></tr>
    <tr><td>F3</td><td>מידע דיבאג</td></tr>
    <tr><td>Esc</td><td>שחרור העכבר</td></tr>
  </table>`;

try {
  const server = new GameServer({ seed, viewDistance }, new WorkerChunkGenerator(seed));
  const [serverEnd, clientEnd] = createLocalPair<ServerMsg, ClientMsg>();
  server.addConnection(serverEnd);
  server.start();

  const client = new GameClient(app, clientEnd, { name: 'Player' });
  let status: ClientStatus = { kind: 'connecting' };
  client.onStatus = (s) => {
    status = s;
    if (s.kind === 'disconnected') showOverlay(`<h1>Cubica</h1><p class="big">החיבור נותק</p><p>${escapeHtml(s.reason)}</p>`);
    else if (!client.controls.locked) showOverlay(s.kind === 'connecting' ? '<h1>Cubica</h1><p class="big">טוען עולם…</p>' : HELP);
  };
  client.controls.onLockChange = (locked) => {
    if (status.kind === 'disconnected') return;
    overlay.style.display = locked ? 'none' : '';
    if (!locked) showOverlay(HELP);
  };
  overlay.addEventListener('click', () => client.controls.lock());
  client.start();
  Object.assign(window, { cubica: { server, client } }); // handy for debugging in the console
} catch (err) {
  console.error(err);
  showOverlay(`<h1>Cubica</h1><p class="big">לא ניתן להפעיל את המשחק</p><p>הדפדפן צריך לתמוך ב-WebGL2. נסו Chrome, Edge, Firefox או Safari בגרסה עדכנית.</p><p class="small">${escapeHtml(String(err))}</p>`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
