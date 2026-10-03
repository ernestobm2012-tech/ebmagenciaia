-- Resumen diario al móvil de los administradores (función push, action=digest).
-- 19:30 UTC son las 21:30 en verano y las 20:30 en invierno (hora de Madrid); la función
-- no envía nada antes de las 20:00 y solo manda uno al día.
select cron.schedule('push-digest', '30 19 * * *', $$
  select net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/push?action=digest',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
