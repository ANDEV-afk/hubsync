import { randomBytes } from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000;
const states = new Map<string, number>();

function removeExpiredStates(now = Date.now()): void {
  for (const [state, expiresAt] of states) {
    if (expiresAt <= now) {
      states.delete(state);
    }
  }
}

export function issueOAuthState(): string {
  removeExpiredStates();
  const state = randomBytes(32).toString("base64url");
  states.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

export function consumeOAuthState(state: string): boolean {
  removeExpiredStates();
  const expiresAt = states.get(state);

  if (!expiresAt || expiresAt <= Date.now()) {
    states.delete(state);
    return false;
  }

  states.delete(state);
  return true;
}
