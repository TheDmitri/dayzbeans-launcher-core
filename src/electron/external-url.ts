/**
 * Which URLs the renderer may hand to `shell.openExternal` (the `open-external` channel).
 *
 * Web and mail links, plus the two Steam client links the launcher uses to open a Workshop
 * item or the DayZ Workshop: `steam://url/CommunityFilePage/<id>` and
 * `steam://url/SteamWorkshopPage/<appid>`. Any other `steam://` link stays refused: the
 * protocol can also run or install games and drive the client (`steam://run/…`,
 * `steam://install/…` has its own fixed-URL channel).
 *
 * Pure (no electron) so it runs under the Karma spec runner.
 */
const STEAM_LINKS = /^steam:\/\/url\/(CommunityFilePage|SteamWorkshopPage)\/\d{1,20}$/;

export function isAllowedExternalUrl(url: string): boolean {
  let scheme: string;
  try {
    scheme = new URL(url).protocol.toLowerCase();
  } catch {
    return false;
  }
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') return true;
  return scheme === 'steam:' && STEAM_LINKS.test(url);
}
