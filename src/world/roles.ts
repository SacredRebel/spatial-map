// Who may do what.
//
//   Three roles, one table. A MEMBER walks, flies and looks: clicks a post and reads what is
//   planned there. A BUILDER has every tool — and what a builder saves is a PROPOSAL, which an
//   admin approves before it reaches the pack. An ADMIN oversees: everything a builder can do,
//   saves that commit at once, and the approving.
//
//   The role comes from a PIN checked by the atlas (it holds the secrets; the world only ever
//   sends the PIN it was given). This is a seam, not an identity system: when Playground's
//   wallet or a Holochain agent key arrives, `roleFor` asks that instead and the table below is
//   unchanged. Every gate in the world reads the table and nothing else.

export type Role = 'member' | 'builder' | 'admin';

export interface Caps {
  /** leave the ground (G) */
  fly: boolean;
  /** click things and read about them */
  inspect: boolean;
  /** the pencil: trees, markers, lines, projects (B) */
  edit: boolean;
  /** blocks and structures moved, turned, raised, added */
  place: boolean;
  /** saves land as proposals for an admin */
  propose: boolean;
  /** saves commit at once */
  commit: boolean;
  /** approve or reject other people's proposals */
  approve: boolean;
}

export const CAPS: Record<Role, Caps> = {
  member:  { fly: true, inspect: true, edit: false, place: false, propose: false, commit: false, approve: false },
  builder: { fly: true, inspect: true, edit: true,  place: true,  propose: true,  commit: false, approve: false },
  admin:   { fly: true, inspect: true, edit: true,  place: true,  propose: true,  commit: true,  approve: true }
};

export interface Session { role: Role; pin: string | null }

const KEY = 'spatial-map:session';

/** the role remembered in this browser tab, or a member */
export function loadSession(): Session {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Session;
      if (s && (s.role === 'admin' || s.role === 'builder') && typeof s.pin === 'string') return s;
    }
  } catch { /* no storage: a member for this visit */ }
  return { role: 'member', pin: null };
}

export function saveSession(s: Session) {
  try {
    if (s.role === 'member') sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* fine */ }
}

/**
 * Ask the atlas what a PIN is worth. `null` when it is worth nothing, or when the atlas cannot
 * be reached — the world never guesses a role.
 */
export async function roleFor(atlas: string, pin: string): Promise<Role | null> {
  try {
    const r = await fetch(`${atlas}/api/pack/role`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && (j.role === 'admin' || j.role === 'builder') ? j.role : null;
  } catch { return null; }
}
