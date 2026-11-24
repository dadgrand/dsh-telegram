// 70-styles.js — the one stylesheet of the plugin (DESIGN.md §6.5, §7.2).
//
// Contract:
//   - a single constant named CSS; no <link>, no CSS files: 90-register.js puts
//     it into one <style data-dsh-telegram="stylesheet"> inside ctx.effect;
//   - every class carries the tg- prefix, and the wave-2 families follow the
//     captain's naming convention: shell tg-*, chat list tg-chatlist-*,
//     thread tg-thread-*, composer tg-composer-*, login tg-login-*;
//   - every color, fill, stroke and label tint resolves through --dsw-alias-*,
//     so the dark palette follows the theme without a single literal color
//     (SKILL/practices.md:32-34); focus rings use the host pair
//     --dsw-focus-ring-color / --dsw-focus-ring-width;
//   - density, spacing and sizes are px values copied from the host's dense
//     list patterns (Telegram-like rows of 52 px, 13/18 text);
//   - everything is scoped under .tg-panel (the overlay panel) or .tg-side-icon
//     (an embedding host's own row); the narrow-width collapse is a container
//     query on the panel itself, not on the viewport.
//
// CLASS INVENTORY handed to the wave-2 fragments (they use these names and
// report any missing rule to the captain; fragments declare no CSS):
//   shell      tg-panel, tg-panel-failed, tg-strip, tg-title, tg-strip-state,
//              tg-dot(.is-ok/.is-warn), tg-strip-label, tg-strip-time,
//              tg-strip-actions, tg-btn(.is-primary/.is-danger/.is-busy,
//              :disabled), tg-icon-btn, tg-warning(.is-error/.is-warn),
//              tg-warning-text, tg-warning-retry, tg-notice, tg-state,
//              tg-state-title, tg-state-body, tg-state-hint,
//              tg-state-placeholder, tg-confirm, tg-confirm-text,
//              tg-confirm-actions, tg-toast, tg-back, tg-scroll,
//              tg-skeleton, tg-skeleton-row, tg-visually-hidden, tg-side-icon
//   layout     tg-layout[data-pane=list|thread], tg-pane, tg-pane-list,
//              tg-pane-thread, tg-pane-composer
//   chat list  tg-chatlist, tg-chatlist-head, tg-chatlist-heading,
//              tg-chatlist-filter, tg-chatlist-refresh, tg-chatlist-body,
//              tg-chatlist-skeleton, tg-chatlist-skeleton-row,
//              tg-chatlist-avatar, tg-chatlist-glyph, tg-chatlist-name,
//              tg-chatlist-last, tg-chatlist-meta, tg-chatlist-time,
//              tg-chatlist-unread, tg-chatlist-flag, tg-chatlist-kind,
//              tg-chatlist-row(.is-selected/.is-pinned), tg-chatlist-note,
//              tg-chatlist-state, tg-chatlist-error, tg-chatlist-retry
//   thread     tg-thread, tg-thread-head, tg-thread-earlier, tg-thread-body,
//              tg-thread-day, tg-thread-skeleton, tg-thread-skeleton-row,
//              tg-thread-row(.is-from-me/.is-pinned), tg-thread-avatar,
//              tg-thread-glyph, tg-thread-author, tg-thread-text,
//              tg-thread-time, tg-thread-mark(.is-edited/.is-reply),
//              tg-thread-reply, tg-thread-media, tg-thread-media-name,
//              tg-thread-media-meta, tg-thread-state, tg-thread-empty
//   composer   tg-composer, tg-composer-head, tg-composer-reply,
//              tg-composer-reply-clear, tg-composer-body, tg-composer-field,
//              tg-composer-textarea, tg-composer-foot, tg-composer-hint,
//              tg-composer-counter, tg-composer-send, tg-composer-disabled
//   login      tg-login, tg-login-title, tg-login-form, tg-login-field,
//              tg-login-label, tg-login-hint, tg-login-actions,
//              tg-login-start, tg-login-verify, tg-login-secondary,
//              tg-login-notice, tg-login-error, tg-login-state,
//              tg-login-skeleton, tg-login-logout
//   shared     tg-input, tg-textarea, tg-btn, tg-icon-btn, tg-badge, tg-chip,
//              tg-counter, tg-skeleton, tg-visually-hidden, tg-scroll

const CSS = String.raw`
 .tg-panel{
   --tg-gap:10px;
   --tg-gap-tight:6px;
   --tg-pad:12px;
   --tg-row-height:52px;
   --tg-radius:10px;
   --tg-radius-sm:8px;
   --tg-list-width:280px;
   --tg-composer-width:300px;
   --tg-fill:var(--dsw-alias-bg-base);
   --tg-fill-1:var(--dsw-alias-bg-layer-1);
   --tg-fill-2:var(--dsw-alias-bg-layer-2);
   --tg-fill-hover:var(--dsw-alias-interactive-bg-hover);
   --tg-fill-ghost:var(--dsw-alias-button-ghost-active-fill);
   --tg-fill-skeleton:var(--dsw-alias-bg-skeleton);
   --tg-stroke:var(--dsw-alias-border-l1);
   --tg-stroke-strong:var(--dsw-alias-border-l2);
   --tg-stroke-selected:var(--dsw-alias-border-selected);
   --tg-ink:var(--dsw-alias-label-primary);
   --tg-ink-2:var(--dsw-alias-label-secondary);
   --tg-ink-3:var(--dsw-alias-label-tertiary);
   --tg-ink-inverted:var(--dsw-alias-label-primary-inverted);
   --tg-ink-on-color:var(--dsw-alias-label-on-color,var(--dsw-alias-label-primary-inverted));
   --tg-accent:var(--dsw-alias-state-business-primary);
   --tg-ok:var(--dsw-alias-state-success-primary);
   --tg-warn:var(--dsw-alias-state-warn-primary);
   --tg-warn-ink:var(--dsw-alias-state-warn-label);
   --tg-error:var(--dsw-alias-state-error-primary);
   --tg-ring:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
   --tg-ring-width:var(--dsw-focus-ring-width,2px);
   position:relative;
   display:flex;
   flex-direction:column;
   height:100%;
   min-height:0;
   overflow:hidden;
   background:var(--tg-fill);
   color:var(--tg-ink);
   font-family:var(--dsw-font-family);
   font-size:13px;
   line-height:18px;
   container-type:inline-size;
   scrollbar-gutter:stable both-edges;
   overscroll-behavior:contain;
 }
 .tg-panel *,.tg-panel *::before,.tg-panel *::after{box-sizing:border-box}
 .tg-panel :focus-visible{outline:none;box-shadow:0 0 0 var(--tg-ring-width) var(--tg-ring)}
 .tg-panel-failed{align-items:center;justify-content:center;padding:24px}
 .tg-strip{flex:none;display:flex;align-items:center;gap:var(--tg-gap);padding:10px var(--tg-pad);border-bottom:1px solid var(--tg-stroke);background:var(--tg-fill);flex-wrap:wrap}
 .tg-title{margin:0;font-size:15px;line-height:20px;font-weight:600;color:var(--tg-ink);white-space:nowrap}
 .tg-strip-state{display:flex;align-items:center;gap:var(--tg-gap-tight);min-width:0;margin-left:auto}
 .tg-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--tg-ink-3)}
 .tg-dot.is-ok{background:var(--tg-ok)}
 .tg-dot.is-warn{background:var(--tg-warn)}
 .tg-strip-label{font-size:12px;line-height:16px;color:var(--tg-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .tg-strip-time{font-size:11px;line-height:14px;color:var(--tg-ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
 .tg-strip-actions{display:flex;align-items:center;gap:var(--tg-gap-tight);flex:none}
 .tg-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:26px;padding:4px 10px;border:1px solid var(--tg-stroke-strong);border-radius:var(--tg-radius-sm);background:var(--tg-fill-1);color:var(--tg-ink);font:inherit;font-size:12px;line-height:16px;cursor:pointer;white-space:nowrap}
 .tg-btn:hover{background:var(--tg-fill-hover)}
 .tg-btn:disabled{opacity:.5;cursor:default}
 .tg-btn.is-primary{border-color:var(--tg-accent);background:var(--tg-accent);color:var(--tg-ink-on-color)}
 .tg-btn.is-primary:hover{background:var(--tg-accent)}
 .tg-btn.is-danger{border-color:var(--tg-error);color:var(--tg-error)}
 .tg-btn.is-danger:hover{background:var(--tg-error);color:var(--tg-ink-on-color)}
 .tg-btn.is-busy{opacity:.7}
 .tg-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:var(--tg-radius-sm);background:transparent;color:var(--tg-ink-3);cursor:pointer;flex:none}
 .tg-icon-btn:hover{background:var(--tg-fill-ghost);color:var(--tg-ink)}
 .tg-icon-btn:disabled{opacity:.5;cursor:default}
 .tg-warning{flex:none;display:flex;align-items:center;gap:var(--tg-gap);margin:0 var(--tg-pad);padding:8px 10px;border:1px solid var(--tg-stroke-strong);border-radius:var(--tg-radius-sm);background:var(--tg-fill-1);color:var(--tg-ink-2)}
 .tg-warning.is-warn{border-color:var(--tg-warn);color:var(--tg-warn-ink)}
 .tg-warning.is-error{border-color:var(--tg-error);color:var(--tg-error)}
 .tg-warning-text{min-width:0;flex:1 1 auto}
 .tg-warning-retry{flex:none}
 .tg-notice{flex:1 1 auto;display:flex;align-items:center;justify-content:center;padding:24px;min-height:0}
 .tg-state{display:flex;flex-direction:column;gap:var(--tg-gap-tight);max-width:420px}
 .tg-state-title{margin:0;font-size:14px;line-height:19px;font-weight:600;color:var(--tg-ink)}
 .tg-state-body{margin:0;font-size:13px;line-height:18px;color:var(--tg-ink-2)}
 .tg-state-hint{margin:0;font-size:12px;line-height:16px;color:var(--tg-ink-3)}
 .tg-state-placeholder{padding:var(--tg-pad)}
 .tg-layout{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:var(--tg-list-width) minmax(0,1fr) var(--tg-composer-width);grid-template-rows:minmax(0,1fr)}
 .tg-pane{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;border-right:1px solid var(--tg-stroke)}
 .tg-pane:last-child{border-right:0}
 .tg-pane-list{background:var(--tg-fill-1)}
 .tg-pane-thread{background:var(--tg-fill)}
 .tg-pane-composer{background:var(--tg-fill-1)}
 .tg-back{display:none}
 .tg-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
 .tg-skeleton{display:block;border-radius:var(--tg-radius-sm);background:var(--tg-fill-skeleton);animation:tg-sweep 1200ms ease-in-out infinite}
 .tg-skeleton-row{display:flex;gap:var(--tg-gap-tight);align-items:center;min-height:var(--tg-row-height);padding:6px var(--tg-pad);border-bottom:1px solid var(--tg-stroke)}
 .tg-visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
 .tg-side-icon{display:block;color:var(--dsw-alias-label-secondary)}
 .tg-side-icon.is-active{color:var(--dsw-alias-label-primary)}
 .tg-chatlist{display:flex;flex-direction:column;min-height:0;height:100%}
 .tg-chatlist-head{flex:none;display:flex;align-items:center;gap:var(--tg-gap-tight);padding:8px var(--tg-pad);border-bottom:1px solid var(--tg-stroke)}
 .tg-chatlist-heading{margin:0;font-size:11px;line-height:14px;font-weight:600;color:var(--tg-ink-3);text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
 .tg-chatlist-filter{flex:1 1 auto;min-width:0}
 .tg-chatlist-refresh{flex:none}
 .tg-chatlist-body{flex:1 1 auto;min-height:0}
 .tg-chatlist-skeleton{display:flex;flex-direction:column}
 .tg-chatlist-skeleton-row{display:flex;gap:var(--tg-gap-tight);align-items:center;min-height:var(--tg-row-height);padding:6px var(--tg-pad);border-bottom:1px solid var(--tg-stroke)}
 .tg-chatlist-row{display:grid;grid-template-columns:36px minmax(0,1fr) auto;grid-template-rows:auto auto;gap:2px var(--tg-gap-tight);align-items:center;width:100%;min-height:var(--tg-row-height);padding:6px var(--tg-pad);border:0;border-bottom:1px solid var(--tg-stroke);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
 .tg-chatlist-row:hover{background:var(--tg-fill-hover)}
 .tg-chatlist-row.is-selected{background:color-mix(in srgb,var(--tg-accent) 14%,transparent);box-shadow:inset 2px 0 0 var(--tg-stroke-selected)}
 .tg-chatlist-row.is-pinned{background:var(--tg-fill-2)}
 .tg-chatlist-avatar{grid-row:1 / span 2;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;color:var(--tg-ink-on-color);overflow:hidden}
 .tg-chatlist-glyph{font-size:13px;line-height:16px;font-weight:600}
 .tg-chatlist-name{grid-column:2;font-size:13px;line-height:17px;color:var(--tg-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .tg-chatlist-last{grid-column:2;font-size:12px;line-height:16px;color:var(--tg-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .tg-chatlist-meta{grid-column:3;grid-row:1 / span 2;display:flex;flex-direction:column;align-items:flex-end;gap:2px}
 .tg-chatlist-time{font-size:11px;line-height:14px;color:var(--tg-ink-3);font-variant-numeric:tabular-nums}
 .tg-chatlist-unread{min-width:18px;padding:1px 5px;border-radius:9px;background:var(--tg-accent);color:var(--tg-ink-on-color);font-size:11px;line-height:14px;text-align:center}
 .tg-chatlist-flag{font-size:11px;line-height:14px;color:var(--tg-ink-3)}
 .tg-chatlist-kind{font-size:11px;line-height:14px;color:var(--tg-ink-3)}
 .tg-chatlist-note{padding:8px var(--tg-pad);font-size:11px;line-height:14px;color:var(--tg-ink-3)}
 .tg-chatlist-state{padding:16px var(--tg-pad);font-size:12px;line-height:16px;color:var(--tg-ink-2)}
 .tg-chatlist-error{padding:8px var(--tg-pad);font-size:12px;line-height:16px;color:var(--tg-error)}
 .tg-chatlist-retry{margin-top:var(--tg-gap-tight)}
 .tg-thread{display:flex;flex-direction:column;min-height:0;height:100%}
 .tg-thread-head{flex:none;display:flex;align-items:center;gap:var(--tg-gap-tight);padding:8px var(--tg-pad);border-bottom:1px solid var(--tg-stroke)}
 .tg-thread-earlier{flex:none}
 .tg-thread-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:2px;padding:8px var(--tg-pad)}
 .tg-thread-day{align-self:center;margin:6px 0;padding:2px 8px;border-radius:9px;background:var(--tg-fill-2);color:var(--tg-ink-2);font-size:11px;line-height:14px}
 .tg-thread-row{display:grid;grid-template-columns:32px minmax(0,1fr);gap:var(--tg-gap-tight);align-items:start;padding:5px 0;border-bottom:1px solid var(--tg-stroke)}
 .tg-thread-row:last-child{border-bottom:0}
 .tg-thread-row.is-pinned{background:color-mix(in srgb,var(--tg-warn) 10%,transparent)}
 .tg-thread-row.is-from-me{grid-template-columns:minmax(0,1fr) 32px}
 .tg-thread-avatar{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;color:var(--tg-ink-on-color);overflow:hidden}
 .tg-thread-glyph{font-size:12px;line-height:15px;font-weight:600}
 .tg-thread-author{display:block;font-size:12px;line-height:16px;font-weight:600;color:var(--tg-accent)}
 .tg-thread-text{margin:0;font-size:13px;line-height:18px;color:var(--tg-ink);white-space:pre-wrap;overflow-wrap:break-word}
 .tg-thread-time{display:block;margin-top:2px;font-size:11px;line-height:14px;color:var(--tg-ink-3);font-variant-numeric:tabular-nums}
 .tg-thread-mark{margin-left:4px;font-size:11px;line-height:14px;color:var(--tg-ink-3)}
 .tg-thread-mark.is-edited,.tg-thread-mark.is-reply{color:var(--tg-ink-3)}
 .tg-thread-reply{display:block;padding:2px 6px;margin-bottom:2px;border-left:2px solid var(--tg-stroke-selected);color:var(--tg-ink-3);font-size:12px;line-height:16px}
 .tg-thread-media{display:inline-flex;flex-direction:column;gap:2px;margin-top:4px;padding:4px 6px;border:1px solid var(--tg-stroke-strong);border-radius:var(--tg-radius-sm);background:var(--tg-fill-1)}
 .tg-thread-media-name{font-size:12px;line-height:16px;color:var(--tg-ink)}
 .tg-thread-media-meta{font-size:11px;line-height:14px;color:var(--tg-ink-3)}
 .tg-thread-skeleton{display:flex;flex-direction:column;gap:4px}
 .tg-thread-skeleton-row{min-height:40px;border-bottom:1px solid var(--tg-stroke)}
 .tg-thread-state{padding:16px var(--tg-pad);font-size:12px;line-height:16px;color:var(--tg-ink-2)}
 .tg-thread-empty{padding:24px var(--tg-pad);font-size:13px;line-height:18px;color:var(--tg-ink-2)}
 .tg-composer{display:flex;flex-direction:column;min-height:0;height:100%;padding:var(--tg-pad);gap:var(--tg-gap-tight)}
 .tg-composer-head{display:flex;align-items:center;gap:var(--tg-gap-tight)}
 .tg-composer-reply{flex:1 1 auto;min-width:0;padding:4px 8px;border-left:2px solid var(--tg-stroke-selected);background:var(--tg-fill-2);color:var(--tg-ink-2);font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .tg-composer-reply-clear{flex:none}
 .tg-composer-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:var(--tg-gap-tight)}
 .tg-composer-field{display:flex;flex-direction:column;gap:4px;min-width:0}
 .tg-composer-textarea{width:100%;min-height:52px;max-height:150px}
 .tg-composer-foot{flex:none;display:flex;align-items:center;gap:var(--tg-gap-tight)}
 .tg-composer-hint{flex:1 1 auto;min-width:0;font-size:11px;line-height:14px;color:var(--tg-ink-3)}
 .tg-composer-counter{flex:none;font-size:11px;line-height:14px;color:var(--tg-ink-3);font-variant-numeric:tabular-nums}
 .tg-composer-send{flex:none}
 .tg-composer-disabled{font-size:12px;line-height:16px;color:var(--tg-ink-3)}
 .tg-login{display:flex;flex-direction:column;gap:var(--tg-gap);min-height:0;padding:16px var(--tg-pad);overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
 .tg-login-title{margin:0;font-size:14px;line-height:19px;font-weight:600;color:var(--tg-ink)}
 .tg-login-form{display:flex;flex-direction:column;gap:var(--tg-gap);max-width:320px}
 .tg-login-field{display:flex;flex-direction:column;gap:4px;min-width:0}
 .tg-login-label{font-size:12px;line-height:16px;color:var(--tg-ink-2)}
 .tg-login-hint{font-size:11px;line-height:14px;color:var(--tg-ink-3)}
 .tg-login-actions{display:flex;flex-wrap:wrap;gap:var(--tg-gap-tight)}
 .tg-login-start,.tg-login-verify{min-width:120px}
 .tg-login-secondary{background:transparent;color:var(--tg-ink-2);border-color:var(--tg-stroke)}
 .tg-login-notice{padding:6px 8px;border-left:2px solid var(--tg-stroke-selected);background:var(--tg-fill-1);color:var(--tg-ink-2);font-size:12px;line-height:16px}
 .tg-login-error{padding:6px 8px;border:1px solid var(--tg-error);border-radius:var(--tg-radius-sm);color:var(--tg-error);font-size:12px;line-height:16px}
 .tg-login-state{font-size:12px;line-height:16px;color:var(--tg-ink-2)}
 .tg-login-skeleton{display:flex;flex-direction:column;gap:6px;max-width:320px}
 .tg-login-logout{margin-top:var(--tg-gap)}
 .tg-input,.tg-textarea{display:block;width:100%;padding:5px 8px;border:1px solid var(--tg-stroke-strong);border-radius:var(--tg-radius-sm);background:var(--tg-fill);color:var(--tg-ink);font:inherit;font-size:13px;line-height:18px}
 .tg-input::placeholder,.tg-textarea::placeholder{color:var(--tg-ink-3)}
 .tg-input:disabled,.tg-textarea:disabled{opacity:.5;cursor:default}
 .tg-textarea{resize:vertical}
 .tg-badge{display:inline-flex;align-items:center;padding:1px 5px;border-radius:9px;background:var(--tg-fill-2);font-size:11px;line-height:14px;color:var(--tg-ink-2)}
 .tg-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border:1px solid var(--tg-stroke-strong);border-radius:var(--tg-radius-sm);background:var(--tg-fill-2);font-size:11px;line-height:14px;color:var(--tg-ink-2)}
 .tg-counter{font-size:11px;line-height:14px;color:var(--tg-ink-3);font-variant-numeric:tabular-nums}
 .tg-confirm{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;flex-direction:column;gap:var(--tg-gap);width:min(420px,calc(100% - 24px));padding:var(--tg-pad);border:1px solid var(--tg-stroke-strong);border-radius:var(--tg-radius);background:var(--tg-fill-2);box-shadow:var(--dsw-elevation-panel,none);z-index:4}
 .tg-confirm-text{margin:0;font-size:13px;line-height:18px;color:var(--tg-ink)}
 .tg-confirm-actions{display:flex;gap:var(--tg-gap-tight)}
 .tg-toast{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);padding:6px 12px;border-radius:var(--tg-radius-sm);background:var(--dsw-alias-toast-bg,var(--tg-fill-2));color:var(--dsw-alias-toast-label,var(--tg-ink));font-size:12px;line-height:16px;z-index:3}
 @keyframes tg-sweep{0%{opacity:.55}50%{opacity:.9}100%{opacity:.55}}
 @container (max-width:860px){
   .tg-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto}
   .tg-pane-list,.tg-pane-thread,.tg-pane-composer{border-right:0}
   .tg-layout[data-pane="list"] .tg-pane-thread,.tg-layout[data-pane="list"] .tg-pane-composer{display:none}
   .tg-layout[data-pane="thread"] .tg-pane-list{display:none}
   .tg-layout[data-pane="thread"] .tg-pane-composer{border-top:1px solid var(--tg-stroke)}
   .tg-layout[data-pane="thread"] .tg-back{display:inline-flex;align-self:flex-start;margin:8px var(--tg-pad);padding:4px 8px;border:1px solid var(--tg-stroke-strong);border-radius:var(--tg-radius-sm);background:var(--tg-fill-1);color:var(--tg-ink-2);font:inherit;font-size:12px;cursor:pointer}
   .tg-composer{padding:8px var(--tg-pad)}
 }
 body[data-ds-dark-theme] .tg-panel{--tg-stroke:var(--dsw-alias-border-l2)}
 @media (prefers-reduced-motion:reduce){
   .tg-skeleton,.tg-skeleton-row,.tg-chatlist-skeleton-row,.tg-thread-skeleton-row,.tg-login-skeleton{animation:none}
   .tg-overlay-panel,.tg-overlay-backdrop{animation:none}
   .tg-panel *,.tg-panel *::before,.tg-panel *::after{transition:none !important}
 }

 .tg-thread-message{min-width:0}
 .tg-profile{display:flex;flex-direction:column;min-height:0;height:100%;overflow:hidden}
 .tg-profile-head{flex:none;display:flex;align-items:center;gap:var(--tg-gap);padding:var(--tg-pad);border-bottom:1px solid var(--tg-stroke)}
 .tg-profile-title{margin:0;font-size:14px;line-height:19px;font-weight:600;color:var(--tg-ink)}
 .tg-profile-head .tg-btn{margin-left:auto}
 .tg-profile-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:var(--tg-pad);display:flex;flex-direction:column;gap:var(--tg-gap)}
 .tg-profile-state{padding:16px var(--tg-pad);font-size:12px;line-height:16px;color:var(--tg-ink-2)}
 .tg-profile-hero{display:flex;align-items:center;gap:var(--tg-gap)}
 .tg-profile-avatar{display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;color:var(--tg-ink-on-color);flex:none}
 .tg-profile-glyph{font-size:20px;line-height:24px;font-weight:600}
 .tg-profile-name{margin:0;font-size:16px;line-height:21px;font-weight:600;color:var(--tg-ink)}
 .tg-profile-badge{display:inline-flex;margin-top:2px;padding:1px 6px;border-radius:9px;background:var(--tg-fill-2);font-size:11px;line-height:14px;color:var(--tg-ink-2)}
 .tg-profile-username{display:block;margin-top:2px;font-size:12px;line-height:16px;color:var(--tg-ink-3)}
 .tg-profile-list{display:grid;grid-template-columns:minmax(96px,140px) minmax(0,1fr);gap:6px var(--tg-gap);margin:0}
 .tg-profile-field{display:contents}
 .tg-profile-label{margin:0;font-size:12px;line-height:16px;color:var(--tg-ink-3)}
 .tg-profile-value{margin:0;font-size:13px;line-height:18px;color:var(--tg-ink);overflow-wrap:break-word}
 .tg-profile-value .tg-btn{margin-left:var(--tg-gap-tight)}
 .tg-login-qr{display:flex;flex-direction:column;align-items:flex-start;gap:var(--tg-gap-tight)}
 .tg-login-qr-code{width:min(260px,100%);height:auto;max-height:260px;border:1px solid var(--tg-stroke-strong);border-radius:var(--tg-radius-sm);image-rendering:pixelated;background:var(--tg-fill)}
 .tg-login-qr-placeholder{display:flex;align-items:center;justify-content:center;width:min(260px,100%);aspect-ratio:1;border:1px dashed var(--tg-stroke-strong);border-radius:var(--tg-radius-sm);color:var(--tg-ink-3);font-size:12px;text-align:center;padding:var(--tg-pad)}
 .tg-login-qr-expiry{font-size:11px;line-height:14px;color:var(--tg-ink-3);font-variant-numeric:tabular-nums}
 .tg-diagnostics{font-size:12px;line-height:16px;color:var(--tg-ink-2)}
 .tg-diagnostics summary{cursor:pointer;color:var(--tg-ink)}
 .tg-diagnostics dl{display:grid;grid-template-columns:minmax(90px,140px) minmax(0,1fr);gap:2px var(--tg-gap);margin:6px 0 0}
 .tg-diagnostics dt{color:var(--tg-ink-3)}
 .tg-diagnostics dd{margin:0;overflow-wrap:break-word}
 .tg-composer-counter.is-over{color:var(--tg-error)}
 /* ---- frame-level overlay (15-overlay.js, DESIGN-v0.2 2) ---- */
 .tg-strip-close{color:var(--tg-ink-3)}
 .tg-overlay-root{position:absolute;inset:0;pointer-events:none}
 .tg-launcher{position:absolute;top:var(--tg-launcher-top,calc(var(--dsh-frame-overlay-top,28px) + 56px));right:var(--tg-launcher-right,12px);z-index:30;display:inline-flex;align-items:center;justify-content:center;inline-size:36px;block-size:36px;padding:0;border:0.5px solid var(--dsw-alias-border-l1);border-radius:50%;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 2px 10px rgb(0 0 0 / 12%);cursor:pointer;pointer-events:auto}
 .tg-launcher:hover{background:var(--dsw-alias-interactive-bg-hover)}
 .tg-launcher:focus-visible{outline:none;box-shadow:0 0 0 var(--tg-ring-width,2px) var(--tg-ring,var(--dsw-alias-state-business-primary))}
 .tg-launcher.is-hidden{display:none}
 .tg-launcher-glyph{display:block;color:currentColor}
 .tg-launcher-dot{position:absolute;top:1px;right:1px;inline-size:8px;block-size:8px;border:1.5px solid var(--dsw-alias-bg-overlay);border-radius:50%}
 .tg-launcher-dot.is-warn{background:var(--dsw-alias-state-warn-primary)}
 .tg-launcher-dot.is-error{background:var(--dsw-alias-state-error-primary)}
 .tg-overlay-backdrop{position:absolute;inset:0;z-index:20;background:var(--dsw-alias-bg-mask-1,rgb(0 0 0 / 28%));pointer-events:auto;animation:tg-overlay-fade 140ms ease-out}
 .tg-overlay-panel{position:absolute;z-index:21;top:var(--dsh-frame-overlay-top,28px);right:24px;bottom:24px;left:24px;max-inline-size:1120px;margin-inline:auto;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;border:0.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgb(0 0 0 / 24%));pointer-events:auto;animation:tg-overlay-in 150ms ease-out}
 .tg-overlay-panel:focus{outline:none}
 .tg-overlay-body{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
 .tg-overlay-screen{flex:1 1 auto;display:flex;min-height:0}
 .tg-overlay-screen > .tg-panel{flex:1 1 auto;min-width:0}
 .tg-overlay-selection{flex:none;display:flex;align-items:center;gap:var(--tg-gap-tight);min-width:0;padding:6px var(--tg-pad);border-top:1px solid var(--tg-stroke);background:var(--tg-fill-1)}
 .tg-overlay-selection-label{flex:none;font-size:11px;line-height:14px;color:var(--tg-ink-3);white-space:nowrap}
 .tg-overlay-selection-list{flex:1 1 auto;display:flex;gap:var(--tg-gap-tight);min-width:0;overflow-x:auto;scrollbar-width:thin}
 .tg-overlay-chip{display:inline-flex;align-items:center;gap:4px;flex:none;max-inline-size:220px;padding:2px 6px;border:1px solid var(--tg-stroke-strong);border-radius:var(--tg-radius-sm);background:var(--tg-fill-2);font-size:11px;line-height:14px;color:var(--tg-ink-2)}
 .tg-overlay-chip-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .tg-overlay-chip-remove{display:inline-flex;align-items:center;justify-content:center;flex:none;inline-size:16px;block-size:16px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--tg-ink-3);font:inherit;font-size:12px;line-height:14px;cursor:pointer}
 .tg-overlay-chip-remove:hover{background:var(--tg-fill-ghost);color:var(--tg-ink)}
 .tg-thread-author-btn{align-self:flex-start;padding:0;border:0;background:transparent;color:var(--tg-accent);font:inherit;font-size:12px;line-height:16px;font-weight:600;text-align:left;cursor:pointer}
 .tg-thread-author-btn:hover{text-decoration:underline}
 .tg-thread-profile{flex:none}
 .tg-profile-actions{display:flex;flex-wrap:wrap;gap:var(--tg-gap-tight)}
 @keyframes tg-overlay-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
 @keyframes tg-overlay-fade{from{opacity:0}to{opacity:1}}
 /* ---- selection surface (t4: 15-overlay.js, 65-selection.js, 68-comment.js) ---- */
 .tg-overlay-toolbar{flex:none;display:flex;align-items:center;gap:var(--tg-gap-tight);min-width:0;padding:6px var(--tg-pad);border-bottom:1px solid var(--tg-stroke);background:var(--tg-fill-1)}
 .tg-overlay-select-toggle{flex:none}
 .tg-overlay-select-toggle[aria-pressed="true"]{border-color:var(--tg-accent);background:var(--tg-accent);color:var(--tg-ink-on-color)}
 .tg-overlay-toolbar-hint{flex:1 1 auto;min-width:0;font-size:11px;line-height:14px;color:var(--tg-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .tg-overlay-body{position:relative}
 .tg-overlay-screen{position:relative;min-width:0}
 .tg-overlay-screen.is-selecting{touch-action:none;user-select:none;-webkit-user-select:none}
 .tg-overlay-screen.is-selecting .tg-chatlist-row,.tg-overlay-screen.is-selecting .tg-thread-row,.tg-overlay-screen.is-selecting .tg-profile-body{cursor:crosshair}
 .tg-overlay-screen.is-selecting .tg-chatlist-row *,.tg-overlay-screen.is-selecting .tg-thread-row *,.tg-overlay-screen.is-selecting .tg-profile-body *{cursor:crosshair}
 .tg-overlay-screen.is-selecting .tg-btn,.tg-overlay-screen.is-selecting .tg-input,.tg-overlay-screen.is-selecting .tg-textarea,.tg-overlay-screen.is-selecting button:not([data-tg-sel]),.tg-overlay-screen.is-selecting a{cursor:pointer}
 .tg-selection-marquee{position:absolute;z-index:5;border:1px solid var(--tg-accent);border-radius:4px;background:color-mix(in oklab,var(--tg-accent) 12%,transparent);pointer-events:none}
 .tg-chatlist-row.is-marked,.tg-thread-row.is-marked,.tg-profile-body.is-marked{outline:2px solid var(--tg-accent);outline-offset:-2px;background:color-mix(in oklab,var(--tg-accent) 10%,var(--tg-fill))}
 .tg-chatlist-mark,.tg-thread-mark-selected,.tg-profile-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;inline-size:14px;block-size:14px;border-radius:50%;background:var(--tg-accent);color:var(--tg-ink-on-color);font-size:10px;line-height:14px;font-weight:700}
 .tg-overlay-selection-actions{display:flex;align-items:center;gap:var(--tg-gap-tight);flex:none;flex-wrap:wrap;justify-content:flex-end}
 .tg-overlay-limit{font-size:11px;line-height:14px;color:var(--tg-warn-ink,var(--tg-warn));max-inline-size:280px}
 .tg-overlay-chip-kind{flex:none;padding:0 4px;border-radius:4px;background:var(--tg-fill-ghost);color:var(--tg-ink-2);font-size:10px;line-height:13px;text-transform:lowercase}
 .tg-overlay-chip-id{flex:none;color:var(--tg-ink-3);font-size:10px;line-height:13px;font-variant-numeric:tabular-nums}
 .tg-overlay-chip-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .tg-overlay-toast{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:8;max-inline-size:min(560px,calc(100% - 24px));padding:6px 12px;border-radius:var(--tg-radius-sm);background:var(--dsw-alias-toast-bg,var(--tg-fill-2));color:var(--dsw-alias-toast-label,var(--tg-ink));font-size:12px;line-height:16px;text-align:center;box-shadow:0 2px 10px rgb(0 0 0 / 12%)}
 .tg-comment{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:7;display:flex;flex-direction:column;gap:var(--tg-gap-tight);inline-size:min(600px,calc(100% - 24px));max-block-size:min(70%,520px);overflow-y:auto;padding:var(--tg-pad);border:0.5px solid var(--tg-stroke-strong);border-radius:var(--tg-radius);background:var(--tg-fill-2);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgb(0 0 0 / 24%));scrollbar-width:thin}
 .tg-comment-head{display:flex;align-items:center;gap:var(--tg-gap-tight);min-width:0}
 .tg-comment-title{margin:0;font-size:13px;line-height:18px;font-weight:600;color:var(--tg-ink)}
 .tg-comment-target{margin-left:auto;min-width:0;max-inline-size:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:14px;color:var(--tg-ink-2)}
 .tg-comment-target.is-missing{color:var(--tg-warn-ink,var(--tg-warn))}
 .tg-comment-close{flex:none}
 .tg-comment-chips{display:flex;align-items:center;gap:var(--tg-gap-tight);min-width:0;overflow-x:auto;scrollbar-width:thin}
 .tg-comment-clear{flex:none}
 .tg-comment-warning{margin:0;padding:4px 8px;border-left:2px solid var(--tg-warn);background:var(--tg-fill-1);color:var(--tg-warn-ink,var(--tg-warn));font-size:11px;line-height:15px}
 .tg-comment-note{min-block-size:64px;max-block-size:160px}
 .tg-comment-meta{display:flex;align-items:center;gap:var(--tg-gap-tight);flex-wrap:wrap}
 .tg-comment-untrusted{flex:1 1 auto;min-width:0;font-size:10px;line-height:13px;color:var(--tg-ink-3)}
 .tg-comment-preview{font-size:11px;line-height:15px;color:var(--tg-ink-2)}
 .tg-comment-preview summary{cursor:pointer;color:var(--tg-ink-2)}
 .tg-comment-prompt{margin:4px 0 0;max-block-size:180px;overflow:auto;padding:6px 8px;border:1px solid var(--tg-stroke);border-radius:var(--tg-radius-sm);background:var(--tg-fill);color:var(--tg-ink);font-family:var(--dsw-code-font-family,monospace);font-size:var(--dsw-code-font-size,11px);line-height:15px;white-space:pre-wrap;overflow-wrap:anywhere}
 .tg-comment-modes{display:flex;align-items:center;gap:var(--tg-gap);flex-wrap:wrap}
 .tg-comment-mode{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:15px;color:var(--tg-ink-2)}
 .tg-comment-error{margin:0;font-size:11px;line-height:15px;color:var(--tg-error)}
 .tg-comment-discard{display:flex;flex-direction:column;gap:var(--tg-gap-tight);padding:6px 8px;border:1px solid var(--tg-error);border-radius:var(--tg-radius-sm)}
 .tg-comment-discard-text{margin:0;font-size:12px;line-height:16px;color:var(--tg-ink)}
 .tg-comment-actions{display:flex;align-items:center;gap:var(--tg-gap-tight);flex-wrap:wrap;justify-content:flex-end}
 .tg-comment-send{margin-left:auto}
 @media (max-width:720px){
   .tg-overlay-panel{top:var(--dsh-frame-overlay-top,28px);right:8px;bottom:8px;left:8px;border-radius:10px}
   .tg-overlay-selection{flex-wrap:wrap}
   .tg-comment{inline-size:calc(100% - 16px);max-block-size:65%}
   .tg-comment-target{max-inline-size:140px}
 }
`
