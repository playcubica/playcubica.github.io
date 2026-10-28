import type { ClientStatus } from './client/GameClient';
import { Account } from './cloud/account';
import { gamepad, Pad, type PadFrame } from './client/input/Gamepad';
import { FirestoreWorlds, type CloudBackend, type CloudWorldInfo } from './cloud/cloudWorlds';
import { GameSession } from './game/GameSession';
import { inviteLink, joinHost, normalizeInviteCode } from './net/peerNetwork';
import { sanitizeName } from './server/GameServer';
import { GameMode, newWorldMeta, WorldStorage, type WorldMeta } from './server/storage/WorldStorage';
import { loadSettings, saveSettings, type Settings } from './client/settings';
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

const PAD_HELP = `
  <table class="keys">
    <tr><td>סטיק שמאלי</td><td>תנועה · לחיצה: ריצה</td></tr>
    <tr><td>סטיק ימני</td><td>הסתכלות</td></tr>
    <tr><td>A / ✕</td><td>קפיצה · פעמיים: טיסה (יצירתי)</td></tr>
    <tr><td>B / ○</td><td>התכופפות</td></tr>
    <tr><td>RT / R2</td><td>כרייה · תקיפה (החזיקו)</td></tr>
    <tr><td>LT / L2</td><td>הנחת בלוק · שימוש · אכילה</td></tr>
    <tr><td>LB RB / L1 R1</td><td>בחירה בסרגל</td></tr>
    <tr><td>Y / △</td><td>מלאי ויצירה</td></tr>
    <tr><td>X / □</td><td>זריקת פריט</td></tr>
    <tr><td>חץ למעלה</td><td>בחירת בלוק (יצירתי)</td></tr>
    <tr><td>View / Share</td><td>רשימת שחקנים</td></tr>
    <tr><td>Menu / Options</td><td>השהיה</td></tr>
  </table>
  <p class="small">במלאי: הסטיק מזיז סמן, A לוקח/מניח, X חצי ערימה, RB העברה מהירה, B סגירה.</p>`;

const debugLabel = (on: boolean) => `מידע טכני על המסך (F3): ${on ? 'מוצג' : 'מוסתר'}`;

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

/** Turns a Google display name into a valid player name (first name, trimmed), or null. */
function nameFromGoogle(displayName: string): string | null {
  const first = displayName.split(/\s+/)[0] ?? '';
  return sanitizeName(first.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 16));
}

function storeName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // storage blocked: the name just isn't remembered
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export class App {
  private readonly screen: HTMLDivElement;
  private session: GameSession | null = null;
  private storage: WorldStorage | null = null;
  private settings: Settings = loadSettings();
  private playerName = loadName();
  private readonly account = new Account();
  private cloudBackend: { uid: string; backend: Promise<CloudBackend> } | null = null;
  private onMainMenu = false;
  /** Index of the menu item the controller points at (-1 = none yet). */
  private padIndex = -1;
  /** Bumped on every screen change, so delayed refreshes know if their screen is still shown. */
  private screenToken = 0;

  constructor(private readonly root: HTMLElement) {
    this.screen = document.createElement('div');
    this.screen.className = 'screen';
    this.screen.dir = 'rtl';
    root.appendChild(this.screen);
    const vd = Number(new URLSearchParams(location.search).get('vd'));
    if (vd) this.settings.viewDistance = Math.max(2, Math.min(12, vd));

    // Best-effort save when the tab is hidden or closed.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.session?.save(true);
    });
    window.addEventListener('beforeunload', () => void this.session?.save());
  }

  async start(): Promise<void> {
    try {
      this.storage = await WorldStorage.open();
    } catch (err) {
      console.warn('IndexedDB unavailable; worlds will not be saved', err);
    }
    this.account.onChange = () => {
      const user = this.account.user;
      // A first sign-in replaces the random default name with the Google first name.
      if (user && /^שחקן\d{3}$/.test(this.playerName)) {
        const n = nameFromGoogle(user.name);
        if (n) {
          this.playerName = n;
          storeName(n);
        }
      }
      if (this.onMainMenu) this.mainMenu();
    };
    this.account.restore();
    gamepad.start();
    gamepad.onConnectChange = () => {
      if (this.onMainMenu) this.mainMenu();
    };
    gamepad.listen((f) => this.padMenu(f));
    const join = new URLSearchParams(location.search).get('join');
    if (join) this.joinMenu(join);
    else this.mainMenu();
  }

  /** Firestore saves of the signed-in player, or null for guests. */
  private cloud(): Promise<CloudBackend> | null {
    const user = this.account.user;
    if (!user) return null;
    if (this.cloudBackend?.uid !== user.uid) this.cloudBackend = { uid: user.uid, backend: FirestoreWorlds.open(user.uid) };
    return this.cloudBackend.backend;
  }

  private accountHtml(): string {
    const st = this.account.state;
    switch (st.kind) {
      case 'off':
        return '';
      case 'loading':
        return '<div class="account small">בודק חשבון…</div>';
      case 'guest':
        return `
          <button class="btn google" data-a="signin">התחברות עם Google</button>
          <p class="small">לא חובה. עם חשבון העולמות נשמרים בענן, ממשיכים מכל מחשב, וחברים רואים שזה באמת את/ה (✓).
            Google תבקש לאשר שיתוף של השם, המייל והתמונה — הם משמשים רק לזה. <a href="privacy.html" target="_blank" rel="noopener">פרטיות</a></p>`;
      case 'signed-in': {
        const u = st.user;
        return `
          <div class="account">
            ${u.photo ? `<img src="${esc(u.photo)}" alt="" referrerpolicy="no-referrer">` : ''}
            <div class="account-who">
              <div>${esc(u.name || 'מחובר/ת')}</div>
              <div class="small" dir="ltr">${esc(u.email)}</div>
            </div>
            <button class="btn small-btn" data-a="signout">התנתק</button>
          </div>`;
      }
    }
  }

  private show(html: string, opts: { menu?: boolean } = {}): HTMLDivElement {
    this.screenToken++;
    this.onMainMenu = false;
    this.padIndex = gamepad.active ? 0 : -1;
    this.screen.innerHTML = html;
    this.screen.style.display = '';
    this.screen.classList.toggle('menu-bg', !!opts.menu);
    return this.screen;
  }

  /** Controller in menus: up/down picks a button, A presses it, left/right moves sliders, B goes back. */
  private padMenu(f: PadFrame): void {
    if (this.screen.style.display === 'none') return;
    const items = [...this.screen.querySelectorAll<HTMLElement>('button:not(:disabled), input[type=range], label.btn')].filter((e) => e.offsetParent !== null);
    for (const e of this.screen.querySelectorAll('.pad-focus')) e.classList.remove('pad-focus');
    if (items.length === 0) return;
    const firstTouch = this.padIndex < 0 && (f.nav.y !== 0 || f.pressed(Pad.A));
    if (firstTouch) this.padIndex = 0;
    else if (f.nav.y) this.padIndex = (this.padIndex + f.nav.y + items.length) % items.length;
    if (this.padIndex < 0) return;
    this.padIndex = Math.min(this.padIndex, items.length - 1);
    const el = items[this.padIndex];
    el.classList.add('pad-focus');
    if (f.nav.y) el.scrollIntoView({ block: 'nearest' });
    if (el instanceof HTMLInputElement && el.type === 'range' && f.nav.x) {
      if (f.nav.x > 0) el.stepUp();
      else el.stepDown();
      el.dispatchEvent(new Event('input'));
    }
    if (f.pressed(Pad.A) && !firstTouch) {
      this.audioClick();
      el.click();
    } else if (f.pressed(Pad.B)) {
      this.screen.querySelector<HTMLElement>('[data-a=back], [data-a=resume]')?.click();
    } else if (f.pressed(Pad.START)) {
      this.screen.querySelector<HTMLElement>('[data-a=resume], [data-a=respawn]')?.click();
    }
  }

  private audioClick(): void {
    this.session?.client.audio.play('click');
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
        ${this.accountHtml()}
        <p class="error" data-f="account-error" style="display:none"></p>
        <label>השם שלך<input class="input" data-f="pname" maxlength="16" value="${esc(this.playerName)}"></label>
        <p class="error" data-f="name-error" style="display:none">שם: 1–16 תווים — אותיות, ספרות, רווח, _ או -</p>
        <button class="btn" data-a="new">עולם חדש</button>
        <button class="btn" data-a="load">טען עולם</button>
        <button class="btn" data-a="join">הצטרף לחבר</button>
        <button class="btn" data-a="settings">הגדרות</button>
        <p class="small">${gamepad.connectedName ? `🎮 ${esc(gamepad.connectedName)} מחובר — חיצים לבחירה, A לאישור, B לחזרה` : '🎮 אפשר לשחק גם עם שלט (Bluetooth או USB) — חברו אותו למחשב ולחצו על כפתור בשלט'}</p>
        ${this.storage ? '' : '<p class="warn">הדפדפן לא מאפשר שמירה (IndexedDB). אפשר לשחק, אבל העולם לא יישמר.</p>'}
        <p class="small">גרסה 1.0</p>
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
    el(s, '[data-a=settings]').onclick = () => this.settingsMenu(() => this.mainMenu());
    const accountError = el(s, '[data-f=account-error]');
    const signIn = s.querySelector<HTMLButtonElement>('[data-a=signin]');
    if (signIn) {
      signIn.onclick = async () => {
        signIn.disabled = true;
        try {
          await this.account.signIn();
        } catch (err) {
          accountError.textContent = err instanceof Error ? err.message : String(err);
          accountError.style.display = '';
        } finally {
          signIn.disabled = false;
        }
      };
    }
    const signOut = s.querySelector<HTMLButtonElement>('[data-a=signout]');
    if (signOut) signOut.onclick = () => void this.account.signOut();
    this.onMainMenu = true;
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
      void this.play(meta);
    };
  }

  private async loadMenu(): Promise<void> {
    const local = this.storage ? await this.storage.listWorlds() : [];
    let cloudList: CloudWorldInfo[] = [];
    let cloudError = '';
    const cloud = this.cloud();
    if (cloud) {
      this.show('<div class="panel"><h2>טוען עולמות מהענן…</h2></div>', { menu: true });
      try {
        cloudList = await withTimeout((await cloud).listWorlds(), 10_000);
      } catch (err) {
        console.warn('cloud list failed', err);
        cloudError = 'לא הצלחנו לטעון את העולמות מהענן. מוצגים רק העולמות שבמחשב הזה.';
      }
    }
    const byId = new Map(cloudList.map((c) => [c.meta.id, c]));
    const rows: Array<{ meta: WorldMeta; local: boolean; cloud: CloudWorldInfo | null }> = local.map((meta) => ({ meta, local: true, cloud: byId.get(meta.id) ?? null }));
    for (const c of cloudList) if (!local.some((w) => w.id === c.meta.id)) rows.push({ meta: c.meta, local: false, cloud: c });
    rows.sort((a, b) => Math.max(b.meta.lastPlayed, b.cloud?.updatedAt ?? 0) - Math.max(a.meta.lastPlayed, a.cloud?.updatedAt ?? 0));
    const signedIn = !!cloud;
    const where = (r: (typeof rows)[number]): string => {
      if (!signedIn) return '';
      if (!r.local) return ' · <span class="cloud-tag">☁ בענן</span>';
      if (!r.cloud) return ' · רק במחשב הזה';
      return r.cloud.updatedAt > r.meta.lastPlayed + 1000 ? ' · <span class="cloud-tag">☁ בענן יש גרסה חדשה יותר</span>' : ' · <span class="cloud-tag">☁ שמור בענן</span>';
    };
    const html = rows.map((r, i) => `
      <div class="world-row" data-i="${i}">
        <div class="world-info">
          <div class="world-name">${esc(r.meta.name)}</div>
          <div class="small">${r.meta.gameMode === GameMode.CREATIVE ? 'יצירתי' : 'הישרדות'} · ${new Date(Math.max(r.meta.lastPlayed, r.cloud?.updatedAt ?? 0)).toLocaleString('he-IL')}${where(r)}</div>
        </div>
        <button class="btn small-btn primary" data-a="play">שחק</button>
        ${signedIn && r.local && !r.cloud ? '<button class="btn small-btn" data-a="upload">גבה לענן</button>' : ''}
        ${r.local ? '<button class="btn small-btn" data-a="export">ייצוא</button>' : ''}
        <button class="btn small-btn danger" data-a="delete">מחק</button>
      </div>`).join('');
    const s = this.show(`
      <div class="panel wide">
        <h2>טען עולם</h2>
        ${cloudError ? `<p class="warn">${cloudError}</p>` : ''}
        <div class="world-list">${html || '<p class="small">אין עדיין עולמות שמורים.</p>'}</div>
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
      const r = rows[Number(row.dataset.i)];
      const meta = r.meta;
      el(row, '[data-a=play]').onclick = async () => {
        const newer = r.cloud && (!r.local || r.cloud.updatedAt > meta.lastPlayed + 1000);
        if (!newer || !cloud) return this.play(meta);
        if (!this.storage) return fail('הדפדפן לא מאפשר שמירה מקומית, אז אי אפשר להוריד את העולם מהענן.');
        this.show('<div class="panel"><h2>מוריד את העולם מהענן…</h2></div>', { menu: true });
        try {
          const got = await (await cloud).getWorld(meta.id);
          if (!got) throw new Error('העולם לא נמצא בענן');
          await this.storage.replaceWorld(got.meta, got.chunks);
          void this.play(got.meta);
        } catch (err) {
          console.error(err);
          await this.loadMenu();
          const e = this.screen.querySelector<HTMLElement>('[data-f=error]');
          if (e) {
            e.textContent = `ההורדה מהענן נכשלה: ${err instanceof Error ? err.message : String(err)}`;
            e.style.display = '';
          }
        }
      };
      const upload = row.querySelector<HTMLButtonElement>('[data-a=upload]');
      if (upload && cloud && this.storage) {
        const storage = this.storage;
        upload.onclick = async () => {
          upload.disabled = true;
          upload.textContent = 'מעלה…';
          try {
            await (await cloud).putWorld(meta, await storage.allChunks(meta.id));
            void this.loadMenu();
          } catch (err) {
            upload.disabled = false;
            upload.textContent = 'גבה לענן';
            fail(`ההעלאה נכשלה: ${err instanceof Error ? err.message : String(err)}`);
          }
        };
      }
      const exp = row.querySelector<HTMLButtonElement>('[data-a=export]');
      if (exp) {
        exp.onclick = async () => {
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
      }
      el(row, '[data-a=delete]').onclick = async () => {
        const places = r.local && r.cloud ? ' מהמחשב ומהענן' : r.cloud ? ' מהענן' : '';
        if (!confirm(`למחוק את "${meta.name}"${places}? אי אפשר לבטל.`)) return;
        try {
          if (r.local) await this.storage!.deleteWorld(meta.id);
          if (r.cloud && cloud) await (await cloud).deleteWorld(meta.id);
          void this.loadMenu();
        } catch (err) {
          fail(`המחיקה נכשלה: ${err instanceof Error ? err.message : String(err)}`);
        }
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
        const token = await this.account.idToken();
        const { transport, leave } = await joinHost(code);
        history.replaceState(null, '', location.pathname);
        this.show('<div class="panel"><h2>מצטרף לעולם…</h2></div>', { menu: true });
        this.session = GameSession.remote(this.root, transport, { viewDistance: this.settings.viewDistance, playerName: name, settings: this.settings, token }, (st) => this.status(st), leave);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    };
  }

  // --- In game ------------------------------------------------------------------

  private async play(meta: WorldMeta): Promise<void> {
    this.show('<div class="panel"><h2>טוען עולם…</h2></div>', { menu: true });
    let cloud: CloudBackend | null = null;
    try {
      cloud = (await this.cloud()) ?? null;
    } catch (err) {
      console.warn('cloud unavailable; playing with local saves only', err);
    }
    try {
      this.session = GameSession.host(this.root, meta, this.storage, {
        viewDistance: this.settings.viewDistance,
        playerName: this.playerName,
        settings: this.settings,
        account: this.account.user?.uid ?? null,
        cloud: this.storage ? cloud : null,
      }, (st) => this.status(st));
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
        ${session.cloudProblem ? `<p class="warn">${esc(session.cloudProblem)}</p>` : ''}
        <button class="btn primary" data-a="resume">חזרה למשחק</button>
        ${invite}
        ${c.hosting ? `<button class="btn" data-a="mode">מצב משחק: ${c.creative ? 'יצירתי' : 'הישרדות'}</button>` : ''}
        <button class="btn" data-a="settings">הגדרות</button>
        <button class="btn" data-a="quit">${server ? 'שמור וצא לתפריט' : 'התנתק'}</button>
        ${gamepad.connectedName ? PAD_HELP : CONTROLS_HELP}
      </div>`);
    el(s, '[data-a=resume]').onclick = () => c.resume();
    el(s, '[data-a=settings]').onclick = () => this.settingsMenu(() => this.session === session && this.pauseMenu(session));
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

  private settingsMenu(back: () => void): void {
    // F3 in the game changes showDebug on its own; pick that up.
    this.settings = { ...this.settings, showDebug: loadSettings().showDebug };
    const st = this.settings;
    const rows: Array<[Exclude<keyof Settings, 'showDebug'>, string, number, number, number, (v: number) => string]> = [
      ['viewDistance', 'מרחק ראייה (צ׳אנקים)', 2, 12, 1, (v) => String(v)],
      ['fov', 'שדה ראייה (FOV)', 50, 110, 1, (v) => `${v}°`],
      ['sensitivity', 'רגישות עכבר', 0.2, 3, 0.1, (v) => v.toFixed(1)],
      ['sound', 'עוצמת צלילים', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`],
      ['music', 'עוצמת מוזיקה', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`],
    ];
    const s = this.show(`
      <div class="panel">
        <h2>הגדרות</h2>
        ${rows.map(([k, label, min, max, step, fmt]) => `
          <div class="settings-row">
            <span>${label}</span>
            <input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${st[k]}" dir="ltr">
            <span data-v="${k}">${fmt(st[k])}</span>
          </div>`).join('')}
        <button class="btn" data-a="debug">${debugLabel(st.showDebug)}</button>
        <p class="small">מרחק ראייה גדול יותר דורש מחשב חזק יותר. ההגדרות נשמרות בדפדפן הזה.</p>
        <button class="btn primary" data-a="back">חזרה</button>
      </div>`, { menu: !this.session });
    for (const [k, , , , , fmt] of rows) {
      const input = el<HTMLInputElement>(s, `[data-k=${k}]`);
      input.oninput = () => {
        this.settings = { ...this.settings, [k]: Number(input.value) };
        el(s, `[data-v=${k}]`).textContent = fmt(Number(input.value));
        saveSettings(this.settings);
        this.session?.client.applySettings(this.settings);
      };
    }
    const debug = el<HTMLButtonElement>(s, '[data-a=debug]');
    debug.onclick = () => {
      this.settings = { ...this.settings, showDebug: !this.settings.showDebug };
      debug.textContent = debugLabel(this.settings.showDebug);
      saveSettings(this.settings);
      this.session?.client.applySettings(this.settings);
    };
    el(s, '[data-a=back]').onclick = back;
  }

  private async exitToMenu(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.show(`<div class="panel"><h2>${session?.isHost === false ? 'מתנתק…' : 'שומר…'}</h2></div>`, { menu: true });
    await session?.stop();
    this.mainMenu();
  }
}
