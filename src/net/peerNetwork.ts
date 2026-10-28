import type { DataConnection, Peer, PeerError } from 'peerjs';
import type { ClientMsg, ServerMsg } from '../shared/protocol/messages';
import { PeerTransport } from './PeerTransport';

// Peer-to-peer networking over WebRTC, using PeerJS's free public signalling server
// only to introduce the two browsers. After that all game data flows directly between
// them. The host's browser runs the server; friends connect with an invite code.

const ID_PREFIX = 'cubica-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const JOIN_TIMEOUT_MS = 20_000;
/** A world's fixed code can still be held for a moment by the page that had it before (reload). */
const CODE_RETRIES = 6;
/** Taking over from a host whose page closed: the signalling server may keep its id for up to a minute. */
const PATIENT_RETRIES = 25;

/** Free public STUN servers (they only help each side discover its public address). */
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

const NAT_HINT = 'ייתכן שהרשת של אחד הצדדים (רשת סלולרית, רשת של עבודה או בית ספר) חוסמת חיבורים ישירים בין מחשבים. נסו מרשת WiFi ביתית.';

/** "ABCD-2345" style code. */
export function newInviteCode(): string {
  const pick = () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `${part()}-${part()}`;
}

/** Accepts codes typed with or without the dash, any case, or a full invite link. Returns null if invalid. */
export function normalizeInviteCode(input: string): string | null {
  let s = input.trim();
  const m = /[?&]join=([^&#]+)/.exec(s);
  if (m) s = decodeURIComponent(m[1]);
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 8 || [...s].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function inviteLink(code: string): string {
  return `${location.origin}${location.pathname}?join=${code}`;
}

const peerId = (code: string) => ID_PREFIX + code.replace('-', '');

/** Turns PeerJS errors into messages a player can act on. */
export function peerErrorMessage(err: PeerError<string> | Error | string): string {
  const type = typeof err === 'string' ? err : 'type' in err ? String(err.type) : '';
  switch (type) {
    case 'peer-unavailable':
      return 'לא נמצא עולם פתוח עם הקוד הזה. בדקו שהקוד נכון ושהמארח לחץ "פתח לחברים" ועדיין במשחק.';
    case 'browser-incompatible':
      return 'הדפדפן הזה לא תומך בחיבורי WebRTC. נסו Chrome, Edge, Firefox או Safari בגרסה עדכנית.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
    case 'disconnected':
      return 'אין חיבור לשרת התיווך החינמי (PeerJS). בדקו את חיבור האינטרנט ונסו שוב בעוד רגע.';
    case 'unavailable-id':
      return 'קוד ההזמנה של העולם הזה תפוס כרגע — אולי העולם פתוח גם בחלון או במחשב אחר. סגרו אותו ונסו שוב, או בחרו "קוד חדש".';
    case 'webrtc':
    case 'negotiation-failed':
      return `החיבור הישיר נכשל. ${NAT_HINT}`;
    case 'timeout':
      return `החיבור לא הצליח תוך 20 שניות. ${NAT_HINT}`;
    default:
      return `שגיאת רשת: ${typeof err === 'string' ? err : err.message}`;
  }
}

async function loadPeer(): Promise<typeof Peer> {
  // Loaded on demand: single player never touches the network.
  const mod = await import('peerjs');
  return mod.Peer;
}

function openPeer(PeerClass: typeof Peer, id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new PeerClass(id, { config: RTC_CONFIG, debug: 1 }) : new PeerClass({ config: RTC_CONFIG, debug: 1 });
    const timer = setTimeout(() => {
      peer.destroy();
      reject(new Error('network'));
    }, JOIN_TIMEOUT_MS);
    peer.once('open', () => {
      clearTimeout(timer);
      resolve(peer);
    });
    peer.once('error', (err) => {
      clearTimeout(timer);
      peer.destroy();
      reject(err);
    });
  });
}

type ServerTransport = PeerTransport<ServerMsg, ClientMsg>;

/** The host side: listens for friends under an invite code. */
export class HostNetwork {
  code = '';
  private peer: Peer | null = null;
  private readonly transports = new Set<ServerTransport>();
  /** Last signalling problem (shown in the pause menu); cleared when it recovers. */
  problem: string | null = null;

  constructor(private readonly onConnection: (t: ServerTransport) => void, private readonly retryDelayMs = 3000) {}

  get connections(): number {
    return this.transports.size;
  }

  /**
   * Starts listening; resolves with the invite code. With `code` (the world's saved code) it keeps that
   * code: if it is still held (the previous page is just going away) it waits and tries again.
   */
  async open(code?: string, patient = false): Promise<string> {
    if (this.peer) return this.code;
    const PeerClass = await loadPeer();
    const fixed = code ?? null;
    for (let attempt = 0; ; attempt++) {
      const tryCode = fixed ?? newInviteCode();
      try {
        this.peer = await openPeer(PeerClass, peerId(tryCode));
        this.code = tryCode;
        break;
      } catch (err) {
        const taken = (err as PeerError<string>).type === 'unavailable-id';
        if (taken && !fixed && attempt < 3) continue;
        if (taken && fixed && attempt < (patient ? PATIENT_RETRIES : CODE_RETRIES)) {
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
          continue;
        }
        throw new Error(peerErrorMessage(err as Error));
      }
    }
    const peer = this.peer;
    peer.on('connection', (conn: DataConnection) => {
      conn.on('open', () => {
        const t = new PeerTransport<ServerMsg, ClientMsg>(conn);
        this.transports.add(t);
        const forward = t.onClose;
        t.onClose = (reason) => {
          this.transports.delete(t);
          forward?.(reason);
        };
        this.onConnection(t);
      });
    });
    peer.on('disconnected', () => {
      // Lost the signalling server: friends already in game stay connected; new ones can't join.
      this.problem = 'החיבור לשרת התיווך אבד — מנסה להתחבר מחדש…';
      setTimeout(() => {
        if (!peer.destroyed) peer.reconnect();
      }, 3000);
    });
    peer.on('open', () => {
      this.problem = null;
    });
    peer.on('error', (err) => {
      this.problem = peerErrorMessage(err);
      console.warn('peer error', err);
    });
    return this.code;
  }

  close(): void {
    for (const t of [...this.transports]) t.close('המארח סגר את העולם');
    const peer = this.peer;
    this.peer = null;
    // Give the goodbye messages a moment to leave.
    setTimeout(() => peer?.destroy(), 400);
  }
}

/** The joining side: connects to a host's invite code. Rejects with a readable message. */
export async function joinHost(code: string): Promise<{ transport: PeerTransport<ClientMsg, ServerMsg>; leave: () => void }> {
  const PeerClass = await loadPeer();
  let peer: Peer;
  try {
    peer = await openPeer(PeerClass);
  } catch (err) {
    throw new Error(peerErrorMessage(err as Error));
  }
  return new Promise((resolve, reject) => {
    const fail = (err: PeerError<string> | Error | string) => {
      clearTimeout(timer);
      peer.destroy();
      reject(new Error(peerErrorMessage(err)));
    };
    const timer = setTimeout(() => fail('timeout'), JOIN_TIMEOUT_MS);
    peer.once('error', (err) => fail(err));
    const conn = peer.connect(peerId(code), { serialization: 'raw', reliable: true });
    conn.on('open', () => {
      clearTimeout(timer);
      const transport = new PeerTransport<ClientMsg, ServerMsg>(conn);
      resolve({ transport, leave: () => setTimeout(() => peer.destroy(), 400) });
    });
    conn.on('error', (err) => fail(err));
    conn.peerConnection?.addEventListener('iceconnectionstatechange', () => {
      if (conn.peerConnection.iceConnectionState === 'failed') fail('webrtc');
    });
  });
}
