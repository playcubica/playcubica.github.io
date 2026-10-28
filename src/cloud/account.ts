import type { FirebaseApp } from 'firebase/app';
import type { Auth, User } from 'firebase/auth';
import { firebaseConfig } from './firebaseConfig';

// Optional Google sign-in (Firebase Auth). The Firebase SDK is loaded lazily: only when the
// player clicks "sign in", or on startup when this browser was signed in last time.

export interface AccountUser {
  uid: string;
  email: string;
  name: string;
  photo: string | null;
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

function wasSignedIn(): boolean {
  try {
    return localStorage.getItem(SIGNED_IN_KEY) === '1';
  } catch {
    return false;
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

  /** Restores the previous session in the background if there was one. */
  restore(): void {
    if (this.configured && wasSignedIn()) void this.loadAuth().catch(() => this.set({ kind: 'guest' }));
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
    this.set(u ? { kind: 'signed-in', user: { uid: u.uid, email: u.email ?? '', name: u.displayName ?? '', photo: u.photoURL } } : { kind: 'guest' });
  }

  /** Opens Google's sign-in popup. Throws a Hebrew message on failure. */
  async signIn(): Promise<void> {
    const auth = await this.loadAuth();
    const { GoogleAuthProvider, signInWithPopup } = await import('firebase/auth');
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
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

  async signOut(): Promise<void> {
    const auth = await this.loadAuth();
    const { signOut } = await import('firebase/auth');
    await signOut(auth);
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
