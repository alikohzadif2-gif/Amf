/**
 * Stage 2D (part 3): the partner's "online" state. Pure logic, no React Native imports.
 *
 * Source: the `{type:'presence', online}` frame of the open `/e2e/ws` socket. There is no polling and no timer: the server tells this phone
 * once after `ready` and again only when the other phone connects or leaves. The app keeps its socket open only while it is in the
 * foreground (PartnerListener), so "online" means "has the app open right now". A phone in the background still gets push.
 */

/** What the screens show. `unknown` = nothing is shown (this phone is not connected, or an older server did not announce presence). */
export type PresenceView = 'online' | 'offline' | 'unknown';

/** Reads one WebSocket frame; returns the announced state, or null when it is not a valid presence frame. */
export function parsePresenceFrame(frame: { type?: unknown; online?: unknown }): boolean | null {
  return frame.type === 'presence' && typeof frame.online === 'boolean' ? frame.online : null;
}

/**
 * `link` is this phone's own connection state. Without a live socket the partner's state cannot be known, so it is never shown as
 * "offline" (that would be a guess). `partnerOnline` null = not announced yet.
 */
export function presenceView(input: { paired: boolean; link: string; partnerOnline: boolean | null }): PresenceView {
  if (!input.paired || input.link !== 'connected' || input.partnerOnline === null) return 'unknown';
  return input.partnerOnline ? 'online' : 'offline';
}
