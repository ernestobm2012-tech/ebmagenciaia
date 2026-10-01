// Datos públicos del proyecto de Supabase. La clave "publishable" puede ir en el
// front: el acceso a los datos lo protegen el login y RLS.
// Aquí NUNCA van claves secretas (service_role, Claude, Meta, correo).
export const SUPABASE_URL = 'https://rhjbpkaesobsbnkvioyh.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_MlzXIojQfbcUDiHUGJ_4wg_lcWCmJ27';

// Cambio orientativo para comparar el coste de IA (USD) con la cuota (EUR).
export const USD_TO_EUR = 0.92;

export const MODELS = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 · rápido y barato (FAQ, horarios, captar datos)' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 · más razonamiento (más caro)' },
];
