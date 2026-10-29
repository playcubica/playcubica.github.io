import type { FirebaseApp } from 'firebase/app';
import type { Auth, User } from 'firebase/auth';
import { firebaseConfig } from './firebaseConfig';

// Accounts (Firebase Auth). Every browser gets a hidden (anonymous) account on its own, so worlds
// are saved in the cloud and shared with friends without anyone signing up. Signing in with Google
// is optional: it upgrades that same account (keeping its worlds) so they can be reached from any
// computer. If anonymous accounts are switched off in Firebase, players stay guests until they sign
// in with Google.

export interface AccountUser {
  uid: string;
  email: string;
  name: string;
  photo: string | null;
  /** The automatic per-browser account (not signed in with Google). */
  anonymous: boolean;
}

export type AccountState =
  | { kind: 'off' } // not configured
  | { kind: 'guest' }
  | { kind: 'loading' }
  | { kind: 'signed-in'; user: AccountUser };

const SIGNED_IN_KEY = 'cubica.signedIn';

function remember(on: boolean): void {
  try {
    if (on) localStorage.setItem(SIGNED_IN_KEY, '1');
    else localStorage.removeItem(SIGNED_IN_KEY);
  } catch {
    // storage blocked: the session is just not restored eagerly
  }
}

let appPromise: Promise<FirebaseApp> | null = null;

/** The Firebase app (loads the SDK on first use). */
export function firebaseApp(): Promise<FirebaseApp> {
  if (!firebaseConfig) return Promise.reject(new Error('Firebase is not configured'));
  const config = firebaseConfig;
  appPromise ??= import('firebase/app').then(({ initializeApp }) => initializeApp(config));
  return appPromise;
}

export class Account {
  state: AccountState = firebaseConfig ? { kind: 'guest' } : { kind: 'off' };
  onChange: (() => void) | null = null;
  private auth: Auth | null = null;
  private authPromise: Promise<Auth> | null = null;

  get configured(): boolean {
    return firebaseConfig !== null;
  }

  get user(): AccountUser | null {
    return this.state.kind === 'signed-in' ? this.state.user : null;
  }

  /** Signed in with Google (not just the automatic account). */
  get google(): AccountUser | null {
    const u = this.user;
    return u && !u.anonymous ? u : null;
  }

  /** Restores the session, or creates this browser's automatic account, in the background. */
  restore(): void {
    if (!this.configured) return;
    void this.loadAuth()
      .then((auth) => this.ensureAccount(auth))
      .catch(() => this.set({ kind: 'guest' }));
  }

  private async ensureAccount(auth: Auth): Promise<void> {
    if (auth.currentUser) return;
    const { signInAnonymously } = await import('firebase/auth');
    try {
      await signInAnonymously(auth);
    } catch (err) {
      console.warn('automatic account unavailable (enable Anonymous sign-in in Firebase)', err);
    }
  }

  private set(state: AccountState): void {
    this.state = state;
    this.onChange?.();
  }

  private loadAuth(): Promise<Auth> {
    if (this.authPromise) return this.authPromise;
    this.set({ kind: 'loading' });
    this.authPromise = (async () => {
      const app = await firebaseApp();
      const { getAuth, onAuthStateChanged } = await import('firebase/auth');
      const auth = getAuth(app);
      await new Promise<void>((resolve) => {
        onAuthStateChanged(auth, (u) => {
          this.applyUser(u);
          resolve();
        });
      });
      this.auth = auth;
      return auth;
    })();
    this.authPromise.catch(() => {
      this.authPromise = null;
    });
    return this.authPromise;
  }

  private applyUser(u: User | null): void {
    remember(!!u);
    // After linking, the Google profile is in providerData until the next sign-in.
    const p = u?.providerData.find((d) => d.providerId === 'google.com');
    this.set(u
      ? { kind: 'signed-in', user: { uid: u.uid, email: u.email ?? p?.email ?? '', name: u.displayName ?? p?.displayName ?? '', photo: u.photoURL ?? p?.photoURL ?? null, anonymous: u.isAnonymous } }
      : { kind: 'guest' });
  }

  /** Opens Google's sign-in popup. Throws a Hebrew message on failure. */
  async signIn(): Promise<void> {
    const auth = await this.loadAuth();
    const { GoogleAuthProvider, signInWithPopup, linkWithPopup, signInWithCredential } = await import('firebase/auth');
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      const current = auth.currentUser;
      if (current?.isAnonymous) {
        // Upgrade the automatic account, so its worlds stay with this player.
        try {
          await linkWithPopup(current, provider);
          await current.reload();
          this.applyUser(auth.currentUser);
        } catch (err) {
          // That Google account already has its own account: switch to it.
          const cred = (err as { code?: string }).code === 'auth/credential-already-in-use' ? GoogleAuthProvider.credentialFromError(err as never) : null;
          if (!cred) throw err;
          await signInWithCredential(auth, cred);
        }
      } else {
        await signInWithPopup(auth, provider);
      }
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      this.applyUser(auth.currentUser);
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      if (code === 'auth/popup-blocked') throw new Error('הדפדפן חסם את חלון ההתחברות. אפשרו חלונות קופצים לאתר ונסו שוב.');
      if (code === 'auth/unauthorized-domain') throw new Error('האתר הזה לא מורשה להתחברות (צריך להוסיף אותו ל-Authorized domains ב-Firebase).');
      if (code === 'auth/network-request-failed') throw new Error('אין חיבור לאינטרנט.');
      throw new Error(`ההתחברות נכשלה (${code || String(err)})`);
    }
  }

  /** Signs out of Google; the browser gets a fresh automatic account. */
  async signOut(): Promise<void> {
    const auth = await this.loadAuth();
    const { signOut } = await import('firebase/auth');
    await signOut(auth);
    await this.ensureAccount(auth);
  }

  /** A fresh ID token for proving this account to a host (null for guests). */
  async idToken(): Promise<string | null> {
    if (!this.auth?.currentUser) return null;
    try {
      return await this.auth.currentUser.getIdToken();
    } catch {
      return null;
    }
  }
}
