/**
 * REQ-LANDING-016: Astro's build-image cache-decision adapter.
 * No response is granted cacheability or positive freshness. This does not
 * implement a general HTTP cache or change Astro's own disk-cache fallback.
 */
export default class BuildImageCachePolicy {
  storable() {
    return false;
  }

  timeToLive() {
    return 0;
  }
}
