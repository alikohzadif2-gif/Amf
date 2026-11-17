/**
 * Is the phone on Wi-Fi or Ethernet (not mobile data)? Used to decide when bigger pictures may be sent.
 * expo-network is loaded lazily: a missing native module means "unknown", which counts as unmetered (never blocks).
 */
export async function isUnmetered(): Promise<boolean> {
  try {
    const Network = await import('expo-network');
    const net = await Network.getNetworkStateAsync();
    return net.type === 'WIFI' || net.type === 'ETHERNET';
  } catch {
    return true;
  }
}
