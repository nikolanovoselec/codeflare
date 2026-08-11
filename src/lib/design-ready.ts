/**
 * Runs in the document head before body parsing. The root class keeps the dark
 * canvas visible while the render-blocking Astro stylesheet and the two critical
 * local fonts resolve. No script means no class, so the complete SSR page remains
 * available to no-JavaScript visitors.
 */
export const DESIGN_READY_SCRIPT = `(()=>{const r=document.documentElement,c='design-loading',f=()=>Promise.all([document.fonts.load('400 1em "Inter Variable"'),document.fonts.load('400 1em "JetBrains Mono Variable"')]).then(()=>r.classList.remove(c),()=>{}),a=()=>{const s=document.querySelector('link[rel="stylesheet"]');if(!s)return false;if(s.sheet)f();else s.addEventListener('load',f,{once:true});return true};r.classList.add(c);if(!a()){const o=new MutationObserver(()=>{if(a())o.disconnect()});o.observe(document.head,{childList:true})}})();`;

/** Keep synchronized by the behavioral CSP integrity test. */
export const DESIGN_READY_CSP_HASH = 'sha256-9M0fjYV3clvSvOaVbrPO+1kSsZW9MSpN441r9nOOSHM=';
