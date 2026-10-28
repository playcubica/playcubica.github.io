// Public Firebase web config (these values are not secrets; access is enforced by the
// Firestore security rules in firestore.rules). null = accounts and cloud saves are hidden.
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
}

export const firebaseConfig: FirebaseWebConfig | null = null;
