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

export const firebaseConfig: FirebaseWebConfig | null = {
  apiKey: 'AIzaSyDw5IkodO1wpp3amzHWJw_JjkRHfD3BZbY',
  authDomain: 'playcubica.firebaseapp.com',
  projectId: 'playcubica',
  storageBucket: 'playcubica.firebasestorage.app',
  messagingSenderId: '780203204958',
  appId: '1:780203204958:web:ff6e1272d535dccc872fcf',
};
