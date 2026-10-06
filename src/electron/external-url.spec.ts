import { isAllowedExternalUrl } from './external-url';

describe('isAllowedExternalUrl', () => {
  it('allows web and mail links', () => {
    expect(isAllowedExternalUrl('https://steamcommunity.com/sharedfiles/filedetails/?id=1559212036')).toBeTrue();
    expect(isAllowedExternalUrl('http://example.com')).toBeTrue();
    expect(isAllowedExternalUrl('mailto:contact@dayzbeanslauncher.com')).toBeTrue();
  });

  it('allows the Steam client Workshop links the launcher uses', () => {
    expect(isAllowedExternalUrl('steam://url/CommunityFilePage/1559212036')).toBeTrue();
    expect(isAllowedExternalUrl('steam://url/SteamWorkshopPage/221100')).toBeTrue();
  });

  it('refuses every other steam:// link', () => {
    expect(isAllowedExternalUrl('steam://run/221100//-connect=1.2.3.4')).toBeFalse();
    expect(isAllowedExternalUrl('steam://install/221100')).toBeFalse();
    expect(isAllowedExternalUrl('steam://url/CommunityFilePage/123/../../run/1')).toBeFalse();
    expect(isAllowedExternalUrl('steam://url/CommunityFilePage/abc')).toBeFalse();
  });

  it('refuses other schemes and malformed input', () => {
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBeFalse();
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBeFalse();
    expect(isAllowedExternalUrl('not a url')).toBeFalse();
  });
});
