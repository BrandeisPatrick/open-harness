// The page's one script: the theme control in the top bar, the pictures that match the theme, and the Copy buttons.
// Without it the page still follows the system's light or dark scheme, pictures included (their <noscript> copies).
(function () {
  'use strict';
  var KEY = 'site-theme';
  var root = document.documentElement;
  var announce = document.getElementById('announce');

  function say(text) {
    if (!announce) return;
    announce.textContent = '';
    setTimeout(function () { announce.textContent = text; }, 50);
  }

  // ---------- Theme ----------

  function stored() {
    try {
      var t = localStorage.getItem(KEY);
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function store(choice) {
    try {
      if (choice === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch (e) {
      /* no storage here (a file opened from disk, a private window): the choice lasts for this page */
    }
  }

  var systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  var current = 'system';

  /**
   * Sets the scheme and gives each themed picture the file of its variant. The pictures carry their two files as
   * data-src and data-src-dark and get a src only here, so the browser fetches only the variant on screen (a
   * <picture> would be fetched ahead by the preload scanner in the system's scheme); the <noscript> copy beside each
   * one is the same picture for a browser without scripts, switched by the system's scheme.
   */
  function apply(choice) {
    current = choice;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
    var dark = choice === 'dark' || (choice === 'system' && systemDark.matches);
    var imgs = document.querySelectorAll('img[data-src-dark]');
    for (var i = 0; i < imgs.length; i++) {
      var want = imgs[i].getAttribute(dark ? 'data-src-dark' : 'data-src');
      if (imgs[i].getAttribute('src') !== want) imgs[i].setAttribute('src', want);
    }
    var buttons = document.querySelectorAll('[data-theme-choice]');
    for (var j = 0; j < buttons.length; j++) buttons[j].setAttribute('aria-pressed', String(buttons[j].getAttribute('data-theme-choice') === choice));
  }

  var names = { light: 'Light theme', dark: 'Dark theme', system: 'Theme matches the system' };
  var control = document.querySelector('.theme');
  if (control) {
    control.hidden = false;
    control.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-theme-choice]');
      if (!b) return;
      var choice = b.getAttribute('data-theme-choice');
      store(choice);
      apply(choice);
      say(names[choice]);
    });
  }
  apply(stored());
  var follow = function () { if (current === 'system') apply('system'); };
  if (systemDark.addEventListener) systemDark.addEventListener('change', follow);
  else if (systemDark.addListener) systemDark.addListener(follow);

  // ---------- Copy ----------

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      area.remove();
      if (ok) resolve();
      else reject(new Error('copy failed'));
    });
  }

  var copies = document.querySelectorAll('.copy[data-copy]');
  for (var k = 0; k < copies.length; k++) {
    (function (btn) {
      var target = document.getElementById(btn.getAttribute('data-copy'));
      if (!target) return;
      var label = btn.closest('.code').querySelector('.code-head span');
      btn.setAttribute('aria-label', 'Copy ' + (label && label.textContent !== 'Terminal' ? label.textContent : 'the commands'));
      btn.hidden = false;
      var timer = 0;
      btn.addEventListener('click', function () {
        copyText(target.textContent).then(
          function () {
            btn.textContent = 'Copied';
            btn.classList.add('done');
            say('Copied');
          },
          function () {
            btn.textContent = 'Select and copy';
            say('Could not copy: select the text and copy it');
          },
        );
        clearTimeout(timer);
        timer = setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('done');
        }, 2000);
      });
    })(copies[k]);
  }
})();
