// Cuenta la visita a la web, sin cookies y sin guardar nada en tu navegador.
// Solo envía la página y de dónde vienes a la función "track". Ver cookies.html y privacidad.html.
// Para que no cuenten tus propias visitas, abre una vez ebmagenciaia.es/?notrack=1
// (se recuerda solo en ese navegador); con ?notrack=0 vuelve a contar.
(function () {
  try {
    var q = location.search;
    try {
      if (/[?&]notrack=1/.test(q)) localStorage.setItem('ebm_notrack', '1');
      if (/[?&]notrack=0/.test(q)) localStorage.removeItem('ebm_notrack');
      if (localStorage.getItem('ebm_notrack')) return;
    } catch (e) { /* sin almacenamiento: se cuenta igual */ }
    if (/^\/admin/.test(location.pathname)) return;
    var body = JSON.stringify({ p: location.pathname, r: document.referrer || '' });
    var url = 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/track';
    if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
    else fetch(url, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' });
  } catch (e) { /* nunca debe romper la web */ }
})();
