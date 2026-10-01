// 宿主层共享 UI 组件: 启动器与联机界面共用。
// 风格与 keypanel/pausemenu.js 保持一致(深底、半透明白框、clamp 字号),
// 但抽成小函数, 免得每个面板各自重复一遍 cssText。
export const FONT = 'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;';

export function mkOverlay(id, z) {
  const el = document.createElement('div');
  el.id = id;
  el.style.cssText =
    'position:fixed;inset:0;z-index:' + (z || 60000) + ';display:flex;align-items:center;justify-content:center;' +
    'box-sizing:border-box;padding:3vmin;background:rgba(0,0,0,0.72);' +
    'pointer-events:auto;touch-action:none;color:#fff;' + FONT +
    'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;';
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return el;
}

export function mkBox() {
  const el = document.createElement('div');
  el.style.cssText =
    'display:flex;flex-direction:column;align-items:stretch;' +
    'width:min(46em,92vw);max-height:92vh;overflow:auto;' +
    'padding:clamp(20px,3.4vmin,40px) clamp(24px,4vmin,56px);border-radius:1em;' +
    'background:rgba(18,18,18,0.94);border:1px solid rgba(255,255,255,0.18);' +
    'box-shadow:0 0 2em rgba(0,0,0,0.6);';
  return el;
}

export function mkTitle(text) {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = FONT + 'font-weight:700;font-size:clamp(20px,4vmin,34px);margin-bottom:0.4em;text-align:center;';
  return el;
}

export function mkHint(text) {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = FONT + 'font-size:clamp(12px,2vmin,17px);line-height:1.5;color:rgba(255,255,255,0.66);' +
    'margin:0.2em 0 0.8em;min-height:1.2em;';
  return el;
}

export function mkLabel(text) {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = FONT + 'font-size:clamp(13px,2.1vmin,18px);color:rgba(255,255,255,0.85);margin:0.5em 0 0.25em;';
  return el;
}

export function mkInput(placeholder, type) {
  const el = document.createElement('input');
  el.type = type || 'text';
  el.placeholder = placeholder || '';
  el.style.cssText =
    'width:100%;box-sizing:border-box;padding:0.6em 0.8em;border-radius:0.5em;' +
    'font-size:clamp(14px,2.2vmin,20px);color:#fff;background:rgba(255,255,255,0.08);' +
    'border:1px solid rgba(255,255,255,0.3);outline:none;' + FONT +
    'user-select:text;-webkit-user-select:text;';
  el.addEventListener('focus', () => {
    el.style.borderColor = 'rgba(255,255,255,0.75)';
  });
  el.addEventListener('blur', () => {
    el.style.borderColor = 'rgba(255,255,255,0.3)';
  });
  return el;
}

export function mkRow() {
  const el = document.createElement('div');
  el.style.cssText = 'display:flex;flex-direction:row;flex-wrap:wrap;justify-content:center;margin-top:1em;gap:0.6em;';
  return el;
}

export function mkCol() {
  const el = document.createElement('div');
  el.style.cssText = 'display:flex;flex-direction:column;flex:1 1 0;';
  return el;
}

export function mkBtn(label, primary) {
  const el = document.createElement('div');
  el.textContent = label;
  el.__btnStyle = primary ? 'primary' : 'normal';
  el.style.cssText = baseBtnCss(primary);
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (el.__disabled) return;
    el.style.background = 'rgba(255,255,255,' + (primary ? '0.5' : '0.3') + ')';
  });
  const restore = () => {
    el.style.cssText = baseBtnCss(primary);
  };
  el.addEventListener('pointerup', restore);
  el.addEventListener('pointercancel', restore);
  el.addEventListener('pointerleave', restore);
  return el;
}

export function baseBtnCss(primary) {
  return (
    'display:flex;align-items:center;justify-content:center;min-width:7em;' +
    'padding:0.75em 2em;border-radius:0.6em;color:#fff;' + FONT +
    'font-weight:600;font-size:clamp(15px,2.4vmin,22px);line-height:1.2;' +
    'text-align:center;cursor:pointer;touch-action:none;box-sizing:border-box;' +
    'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;' +
    'background:rgba(255,255,255,' + (primary ? '0.22' : '0.1') + ');' +
    'border:1px solid rgba(255,255,255,' + (primary ? '0.6' : '0.35') + ');'
  );
}

export function setBtnDisabled(btn, disabled) {
  btn.__disabled = !!disabled;
  btn.style.opacity = disabled ? '0.45' : '1';
  btn.style.cursor = disabled ? 'default' : 'pointer';
}

export function onTap(el, fn) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn(e);
  });
}
