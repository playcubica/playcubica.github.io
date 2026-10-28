import type { ClientStatus } from './client/GameClient';
import { GameSession } from './game/GameSession';
import { inviteLink, joinHost, normalizeInviteCode } from './net/peerNetwork';
import { sanitizeName } from './server/GameServer';
import { GameMode, newWorldMeta, WorldStorage, type WorldMeta } from './server/storage/WorldStorage';
import { DEFAULT_VIEW_DISTANCE } from './shared/constants';
import { randomSeed, seedFromString } from './shared/rng';

// Menus (Hebrew, RTL) and the lifecycle of a game session.

const CONTROLS_HELP = `
  <table class="keys">
    <tr><td>W A S D</td><td>תנועה</td></tr>
    <tr><td>Space</td><td>קפיצה · שחייה · פעמיים: טיסה (יצירתי)</td></tr>
    <tr><td>Shift</td><td>התכופפות · ירידה בטיסה</td></tr>
    <tr><td>Ctrl</td><td>ריצה</td></tr>
    <tr><td>קליק שמאלי</td><td>כרייה (החזיקו)</td></tr>
    <tr><td>קליק ימני</td><td>הנחת בלוק</td></tr>
    <tr><td>קליק אמצעי</td><td>בחירת בלוק (יצירתי)</td></tr>
    <tr><td>1–9 / גלגלת</td><td>בחירה בסרגל</td></tr>
    <tr><td>E</td><td>מלאי ויצירה (2×2)</td></tr>
    <tr><td>קליק ימני</td><td>פתיחת שולחן / כבשן / תיבה / דלת · אכילה</td></tr>
    <tr><td>Q</td><td>זריקת פריט (Ctrl+Q: כל הערימה)</td></tr>
    <tr><td>T  /  /</td><td>צ'אט · פקודות</td></tr>
    <tr><td>Tab</td><td>רשימת שחקנים (החזיקו)</td></tr>
    <tr><td>F3</td><td>מידע דיבאג</td></tr>
    <tr><td>Esc</td><td>השהיה</td></tr>
  </table>`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function el<T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T {
  return root.querySelector(sel) as T;
}

const NAME_KEY = 'cubica.name';

/** The player's name, remembered in this browser. */
function loadName(): string {
  try {
    const saved = sanitizeName(localStorage.getItem(NAME_KEY));
    if (saved) return saved;
  } catch {
    // storage blocked: fall through
  }
  return `שחקן${Math.floor(100 + Math.random() * 900)}`;
}

function storeName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // storage blocked: the name just isn't remembered
  }
}

export class App {
  private readonly screen: HTMLDivElement;
  private session: GameSession | null = null;
  private storage: WorldStorage | null = null;
  private readonly viewDistance: number;
  private playerName = loadName();
  /** Bumped on every screen change, so delayed refreshes know if their screen is still shown. */
  private screenToken = 0;

  constructor(private readonly root: HTMLElement) {
    this.screen = document.createElement('div');
    this.screen.className = 'screen';
    this.screen.dir = 'rtl';
    root.appendChild(this.screen);
    const vd = Number(new URLSearchParams(location.search).get('vd'));
    this.viewDistance = Math.max(2, Math.min(16, vd || DEFAULT_VIEW_DISTANCE));

    // Best-effort save when the tab is hidden or closed.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.session?.save();
    });
    window.addEventListener('beforeunload', () => void this.session?.save());
  }

  async start(): Promise<void> {
    try {
      this.storage = await WorldStorage.open();
    } catch (err) {
      console.warn('IndexedDB unavailable; worlds will not be saved', err);
    }
    const join = new URLSearchParams(location.search).get('join');
    if (join) this.joinMenu(join);
    else this.mainMenu();
  }

  private show(html: string, opts: { menu?: boolean } = {}): HTMLDivElement {
    this.screenToken++;
    this.screen.innerHTML = html;
    this.screen.style.display = '';
    this.screen.classList.toggle('menu-bg', !!opts.menu);
    return this.screen;
  }

  private hide(): void {
    this.screenToken++;
    this.screen.style.display = 'none';
  }

  // --- Main menu ----------------------------------------------------------------

  private mainMenu(): void {
    const s = this.show(`
      <div class="panel">
        <h1 class="logo">Cubica</h1>
        <p class="tagline">עולם קוביות פתוח לבנייה, חקירה והישרדות</p>
        <label>השם שלך<input class="input" data-f="pname" maxlength="16" value="${esc(this.playerName)}"></label>
        <p class="error" data-f="name-error" style="display:none">שם: 1–16 תווים — אותיות, ספרות, רווח, _ או -</p>
        <button class="btn" data-a="new">עולם חדש</button>
        <button class="btn" data-a="load">טען עולם</button>
        <button class="btn" data-a="join">הצטרף לחבר</button>
        ${this.storage ? '' : '<p class="warn">הדפדפן לא מאפשר שמירה (IndexedDB). אפשר לשחק, אבל העולם לא יישמר.</p>'}
        <p class="small">גרסה 0.4 · שלב 4</p>
      </div>`, { menu: true });
    const nameInput = el<HTMLInputElement>(s, '[data-f=pname]');
    const nameOk = (): boolean => {
      const n = sanitizeName(nameInput.value);
      el(s, '[data-f=name-error]').style.display = n ? 'none' : '';
      if (n) {
        this.playerName = n;
        storeName(n);
      }
      return !!n;
    };
    nameInput.oninput = () => nameOk();
    el(s, '[data-a=new]').onclick = () => nameOk() && this.newWorldMenu();
    el(s, '[data-a=load]').onclick = () => nameOk() && void this.loadMenu();
    el(s, '[data-a=join]').onclick = () => nameOk() && this.joinMenu();
  }

  private newWorldMenu(): void {
    let mode: number = GameMode.SURVIVAL;
    const s = this.show(`
      <div class="panel">
        <h2>עולם חדש</h2>
        <label>שם העולם<input class="input" data-f="name" maxlength="32" value="העולם שלי"></label>
        <label>זרע (Seed) — לא חובה<input class="input" data-f="seed" maxlength="40" placeholder="אקראי" dir="ltr"></label>
        <div class="label">מצב משחק</div>
        <div class="toggle">
          <button class="btn small-btn on" data-m="0">הישרדות</button>
          <button class="btn small-btn" data-m="1">יצירתי</button>
        </div>
        <p class="small" data-f="mode-help">כורים, אוספים משאבים ובונים. כל בלוק דורש זמן שבירה.</p>
        <button class="btn primary" data-a="create">צור עולם</button>
        <button class="btn" data-a="back">חזרה</button>
      </div>`, { menu: true });
    const help = el(s, '[data-f=mode-help]');
    s.querySelectorAll<HTMLButtonElement>('[data-m]').forEach((b) => {
      b.onclick = () => {
        mode = Number(b.dataset.m);
        s.querySelectorAll('[data-m]').forEach((o) => o.classList.toggle('on', o === b));
        help.textContent = mode === GameMode.CREATIVE
          ? 'כל הבלוקים זמינים, שבירה מיידית, טיסה (Space פעמיים).'
          : 'כורים, אוספים משאבים ובונים. כל בלוק דורש זמן שבירה.';
      };
    });
    el(s, '[data-a=back]').onclick = () => this.mainMenu();
    el(s, '[data-a=create]').onclick = async () => {
      const name = el<HTMLInputElement>(s, '[data-f=name]').value.trim() || 'העולם שלי';
      const seedText = el<HTMLInputElement>(s, '[data-f=seed]').value.trim();
      const meta = newWorldMeta(name, seedText ? seedFromString(seedText) : randomSeed(), mode);
      await this.storage?.saveMeta(meta);
      this.play(meta);
    };
  }

  private async loadMenu(): Promise<void> {
    const worlds = this.storage ? await this.storage.listWorlds() : [];
    const rows = worlds.map((w) => `
      <div class="world-row" data-id="${esc(w.id)}">
        <div class="world-info">
          <div class="world-name">${esc(w.name)}</div>
          <div class="small">${w.gameMode === GameMode.CREATIVE ? 'יצירתי' : 'הישרדות'} · ${new Date(w.lastPlayed).toLocaleString('he-IL')}</div>
        </div>
        <button class="btn small-btn primary" data-a="play">שחק</button>
        <button class="btn small-btn" data-a="export">ייצוא</button>
        <button class="btn small-btn danger" data-a="delete">מחק</button>
      </div>`).join('');
    const s = this.show(`
      <div class="panel wide">
        <h2>טען עולם</h2>
        <div class="world-list">${rows || '<p class="small">אין עדיין עולמות שמורים.</p>'}</div>
        <p class="warn" data-f="error" style="display:none"></p>
        <label class="btn">ייבוא עולם מקובץ…<input type="file" accept=".cubica" data-f="file" hidden></label>
        <button class="btn" data-a="back">חזרה</button>
      </div>`, { menu: true });
    const error = el(s, '[data-f=error]');
    const fail = (msg: string) => {
      error.textContent = msg;
      error.style.display = '';
    };
    el(s, '[data-a=back]').onclick = () => this.mainMenu();
    s.querySelectorAll<HTMLElement>('.world-row').forEach((row) => {
      const meta = worlds.find((w) => w.id === row.dataset.id)!;
      el(row, '[data-a=play]').onclick = () => this.play(meta);
      el(row, '[data-a=export]').onclick = async () => {
        try {
          const blob = await this.storage!.exportWorld(meta.id);
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${meta.name.replace(/[\\/:*?"<>|]/g, '_')}.cubica`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        } catch (err) {
          fail(`הייצוא נכשל: ${String(err)}`);
        }
      };
      el(row, '[data-a=delete]').onclick = async () => {
        if (!confirm(`למחוק את "${meta.name}"? אי אפשר לבטל.`)) return;
        await this.storage!.deleteWorld(meta.id);
        void this.loadMenu();
      };
    });
    el<HTMLInputElement>(s, '[data-f=file]').onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file || !this.storage) return;
      try {
        await this.storage.importWorld(new Uint8Array(await file.arrayBuffer()));
        void this.loadMenu();
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    };
  }

  private joinMenu(prefill = ''): void {
    const s = this.show(`
      <div class="panel">
        <h2>הצטרף לחבר</h2>
        <label>קוד הזמנה (או הקישור שקיבלתם)<input class="input" data-f="code" placeholder="ABCD-2345" dir="ltr" value="${esc(prefill)}"></label>
        <label>השם שלך<input class="input" data-f="pname" maxlength="16" value="${esc(this.playerName)}"></label>
        <p class="error" data-f="error" style="display:none"></p>
        <button class="btn primary" data-a="join">הצטרף</button>
        <button class="btn" data-a="back">חזרה</button>
        <p class="small">החיבור ישיר בין המחשבים (WebRTC). שרת תיווך ציבורי וחינמי רק מכיר ביניהם.</p>
      </div>`, { menu: true });
    const error = el(s, '[data-f=error]');
    const button = el<HTMLButtonElement>(s, '[data-a=join]');
    const fail = (msg: string) => {
      error.textContent = msg;
      error.style.display = '';
      button.disabled = false;
      button.textContent = 'הצטרף';
    };
    el(s, '[data-a=back]').onclick = () => {
      history.replaceState(null, '', location.pathname);
      this.mainMenu();
    };
    button.onclick = async () => {
      const code = normalizeInviteCode(el<HTMLInputElement>(s, '[data-f=code]').value);
      const name = sanitizeName(el<HTMLInputElement>(s, '[data-f=pname]').value);
      if (!code) return fail('הקוד צריך להיות 8 תווים, למשל ABCD-2345.');
      if (!name) return fail('שם: 1–16 תווים — אותיות, ספרות, רווח, _ או -');
      this.playerName = name;
      storeName(name);
      error.style.display = 'none';
      button.disabled = true;
      button.textContent = 'מתחבר…';
      try {
        const { transport, leave } = await joinHost(code);
        history.replaceState(null, '', location.pathname);
        this.show('<div class="panel"><h2>מצטרף לעולם…</h2></div>', { menu: true });
        this.session = GameSession.remote(this.root, transport, { viewDistance: this.viewDistance, playerName: name }, (st) => this.status(st), leave);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    };
  }

  // --- In game ------------------------------------------------------------------

  private play(meta: WorldMeta): void {
    this.show('<div class="panel"><h2>טוען עולם…</h2></div>', { menu: true });
    try {
      this.session = GameSession.host(this.root, meta, this.storage, { viewDistance: this.viewDistance, playerName: this.playerName }, (st) => this.status(st));
    } catch (err) {
      console.error(err);
      const s = this.show(`
        <div class="panel">
          <h2>לא ניתן להפעיל את המשחק</h2>
          <p>הדפדפן צריך לתמוך ב-WebGL2. נסו Chrome, Edge, Firefox או Safari בגרסה עדכנית.</p>
          <p class="small" dir="ltr">${esc(String(err))}</p>
          <button class="btn" data-a="menu">חזרה לתפריט</button>
        </div>`, { menu: true });
      el(s, '[data-a=menu]').onclick = () => this.mainMenu();
    }
  }

  private status(st: ClientStatus): void {
    const session = this.session;
    if (!session) return;
    switch (st.kind) {
      case 'connecting':
        this.show('<div class="panel"><h2>טוען עולם…</h2></div>', { menu: true });
        break;
      case 'playing':
        this.hide();
        break;
      case 'paused':
        this.pauseMenu(session);
        break;
      case 'dead': {
        const s = this.show(`
          <div class="panel death">
            <h2>מתת!</h2>
            <p>${esc(st.message)}</p>
            <p class="small">החפצים שלך נשארו במקום שבו מתת.</p>
            <button class="btn primary" data-a="respawn">חזרה לחיים</button>
            <button class="btn" data-a="quit">${session.isHost ? 'שמור וצא לתפריט' : 'התנתק'}</button>
          </div>`);
        el(s, '[data-a=respawn]').onclick = () => session.client.respawn();
        el(s, '[data-a=quit]').onclick = () => void this.exitToMenu();
        break;
      }
      case 'disconnected': {
        const s = this.show(`
          <div class="panel">
            <h2>החיבור נותק</h2>
            <p>${esc(st.reason)}</p>
            <button class="btn" data-a="menu">חזרה לתפריט</button>
          </div>`);
        el(s, '[data-a=menu]').onclick = () => void this.exitToMenu();
        break;
      }
    }
  }

  private pauseMenu(session: GameSession, openError = ''): void {
    const c = session.client;
    const server = session.server;
    const code = session.inviteCode;
    let invite = '';
    if (server && code) {
      const others = server.playerCount - 1;
      invite = `
        <div class="invite">
          <div>העולם פתוח לחברים · קוד הזמנה:</div>
          <div class="invite-code">${esc(code)}</div>
          <div class="invite-link">${esc(inviteLink(code))}</div>
          <button class="btn small-btn" data-a="copy">העתק קישור הזמנה</button>
          <div class="small">${others > 0 ? `מחוברים עוד ${others} שחקנים` : 'ממתין לחברים… (עד 8 שחקנים)'}</div>
          ${session.networkProblem ? `<div class="error">${esc(session.networkProblem)}</div>` : ''}
        </div>`;
    } else if (server) {
      invite = `<button class="btn" data-a="open">פתח לחברים</button>${openError ? `<p class="error">${esc(openError)}</p>` : ''}`;
    }
    const s = this.show(`
      <div class="panel">
        <h2>${esc(server ? server.meta.name : 'עולם של חבר')}</h2>
        <button class="btn primary" data-a="resume">חזרה למשחק</button>
        ${invite}
        ${c.hosting ? `<button class="btn" data-a="mode">מצב משחק: ${c.creative ? 'יצירתי' : 'הישרדות'}</button>` : ''}
        <button class="btn" data-a="quit">${server ? 'שמור וצא לתפריט' : 'התנתק'}</button>
        ${CONTROLS_HELP}
      </div>`);
    el(s, '[data-a=resume]').onclick = () => c.resume();
    const open = s.querySelector<HTMLButtonElement>('[data-a=open]');
    if (open) {
      open.onclick = async () => {
        open.disabled = true;
        open.textContent = 'פותח…';
        try {
          await session.openToFriends();
          if (this.session === session) this.pauseMenu(session);
        } catch (err) {
          if (this.session === session) this.pauseMenu(session, err instanceof Error ? err.message : String(err));
        }
      };
    }
    if (code) {
      // Keep the connected-players count fresh while the menu is open.
      const token = this.screenToken;
      setTimeout(() => {
        if (this.screenToken === token && this.session === session) this.pauseMenu(session);
      }, 3000);
    }
    const copy = s.querySelector<HTMLButtonElement>('[data-a=copy]');
    if (copy && code) {
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(inviteLink(code));
          copy.textContent = 'הועתק!';
        } catch {
          copy.textContent = 'סמנו והעתיקו את הקישור למעלה';
        }
      };
    }
    const mode = s.querySelector<HTMLButtonElement>('[data-a=mode]');
    if (mode) {
      mode.onclick = () => {
        c.setGameMode(c.creative ? GameMode.SURVIVAL : GameMode.CREATIVE);
        // The host's answer arrives asynchronously; refresh the label after it.
        setTimeout(() => this.session === session && this.pauseMenu(session), 50);
      };
    }
    el(s, '[data-a=quit]').onclick = () => void this.exitToMenu();
  }

  private async exitToMenu(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.show(`<div class="panel"><h2>${session?.isHost === false ? 'מתנתק…' : 'שומר…'}</h2></div>`, { menu: true });
    await session?.stop();
    this.mainMenu();
  }
}
